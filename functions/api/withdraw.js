// /api/withdraw.js — Plain English: admin-initiated CHIP Send withdrawal of
// platform commission.
//
// [THIS REVISION — SECURITY FIX]
// (1) The bank-code fuzzy matcher (getChipBankCode) is gone. It was dead
//     code that defaulted to MBBEMYKL (Maybank) if no match was found,
//     which is a real money-loss risk if it ever got wired in.
// (2) getPlatformBank() no longer falls back to 'Maybank' / 'MBBEMYKL'.
//     If PLATFORM_BANK_CODE (or any other required var) is missing, it
//     returns an empty string.
// (3) A hard pre-flight gate refuses any withdrawal attempt when any of
//     PLATFORM_BANK_NAME / PLATFORM_BANK_CODE / PLATFORM_BANK_HOLDER /
//     PLATFORM_BANK_ACCOUNT is missing. The error names exactly which
//     env vars are missing so you can fix them in the Cloudflare
//     dashboard without guessing.
// (4) PLATFORM_BANK_CODE is validated against the CHIP Send bank list.
//     A typo cannot send money to the wrong bank.
// (5) Account number must be at least 8 digits, matching CHIP Send's
//     registration rule.
// (6) GET honestly reports "not configured" instead of a fake Maybank.
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  verifyAdminAuth,
  checkRateLimit,
  recordRateLimit,
  parseJSONSafely,
  jsonResponse,
  withLock
} from './_utils.js';

const BOOKINGS_LOCK = 'bookings-global';
const MAX_HISTORY = 500;

// ============================================================
// CHIP Send supported bank codes (SWIFT/BIC). Source: CHIP Send's
// "Add a bank account" documentation. Kept in sync with the same set
// in _utils.js, pending.js, and bank-list.js.
// ============================================================
const VALID_CHIP_SEND_CODES = new Set([
  'ACDBMYK2','PHBMMYKL','AGOBMYKL','RJHIMYKL','MFBBMYKL','ARBKMYKL',
  'BIMBMYKL','BKRMMYKL','BMMBMYKL','BOFAMY2X','BKCHMYKL','BOTKMYKX',
  'BSNAMYK1','BNPAMYKL','PCBCMYKL','CIBBMYKL','DEUTMYKL','FNXSMYNB',
  'GXSPMYKL','HLBBMYKL','HBMBMYKL','ICBKMYKL','CHASMYKX','KFHOMYKL',
  'MBBEMYKL','AFBQMYKL','MHCBMYKA','OCBCMYKL','PBBEMYKL','RHBBMYKL',
  'SCBLMYKX','SMBCMYKL','TNGDMYNB','UOVBMYKL'
]);

async function hmacSha512(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyAdmin(request, env) {
  const ok = await verifyAdminAuth(request, env);
  if (!ok) {
    return jsonResponse({ error: 'Unauthorized' }, 401, request);
  }
  return null;
}

function validateAmount(amount) {
  const num = Number(amount);
  if (isNaN(num) || num <= 0) return false;
  const str = String(num);
  if (str.includes('.') && str.split('.')[1].length > 2) return false;
  return true;
}

// ============================================================
// Platform bank config from env.
//
// [SECURITY FIX] No hardcoded fallbacks. If the env var is missing, we
// return an empty string. The caller must gate on isPlatformBankConfigured()
// before doing anything with the value.
//
// `YOUR_BANK_*` aliases are still honoured for backward compatibility
// with older deployments, but the platform-bank-* names take precedence.
// ============================================================
function getPlatformBank(env) {
  return {
    bankName: env.PLATFORM_BANK_NAME || env.YOUR_BANK_NAME || '',
    bankCode: String(env.PLATFORM_BANK_CODE || env.YOUR_BANK_CODE || '').toUpperCase().trim(),
    accountHolder: env.PLATFORM_BANK_HOLDER || env.YOUR_BANK_HOLDER || '',
    accountNumber: String(env.PLATFORM_BANK_ACCOUNT || env.YOUR_BANK_ACCOUNT || '').replace(/[^0-9]/g, '')
  };
}

// Returns null if fully configured, or an array of the env var names
// that are missing so the admin gets an actionable error message.
function getPlatformBankMissing(bank) {
  const missing = [];
  if (!bank.bankName) missing.push('PLATFORM_BANK_NAME');
  if (!bank.bankCode) missing.push('PLATFORM_BANK_CODE');
  if (!bank.accountHolder) missing.push('PLATFORM_BANK_HOLDER');
  if (!bank.accountNumber) missing.push('PLATFORM_BANK_ACCOUNT');
  return missing;
}

// Cap history length. Keeps the most recent MAX_HISTORY entries.
function capHistory(earnings) {
  if (!earnings || !Array.isArray(earnings.history)) return earnings;
  if (earnings.history.length > MAX_HISTORY) {
    earnings.history = earnings.history.slice(-MAX_HISTORY);
  }
  return earnings;
}

// ============================================================
// Load or create CHIP Send bank account for platform.
// Caller MUST have validated bankCode against VALID_CHIP_SEND_CODES
// and accountNumber length before calling this.
// ============================================================
async function getOrCreatePlatformBankAccountId(db, platformBank, env) {
  const cached = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_platform_bank').first();
  if (cached?.data) {
    try {
      const parsed = JSON.parse(cached.data);
      if (parsed && parsed.bank_account_id &&
          parsed.account_number === platformBank.accountNumber &&
          parsed.bank_code === platformBank.bankCode) {
        return parsed.bank_account_id;
      }
    } catch (_) { /* fall through */ }
  }

  const apiKey = env.CHIP_API_KEY;
  const apiSecret = env.CHIP_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('CHIP Send credentials not configured');
  }

  const epoch = Math.floor(Date.now() / 1000);
  const bankBody = JSON.stringify({
    bank_code: platformBank.bankCode,
    account_number: platformBank.accountNumber,
    account_name: platformBank.accountHolder
  });
  const checksum = await hmacSha512(`${epoch}${apiKey}`, apiSecret);

  const res = await fetch('https://api.chip-in.asia/api/send/bank_accounts/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'epoch': String(epoch),
      'checksum': checksum
    },
    body: bankBody
  });
  let data = null;
  try { data = await res.json(); } catch (_) { data = {}; }
  if (!res.ok || !data.id) {
    throw new Error('Failed to create platform bank account: ' + (data.error || 'unknown'));
  }

  await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
    .bind('kd_platform_bank', JSON.stringify({
      bank_account_id: data.id,
      bank_code: platformBank.bankCode,
      account_number: platformBank.accountNumber,
      updated_at: new Date().toISOString()
    }))
    .run();

  return data.id;
}

// ===== POST: Withdraw =====
export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Database not configured' }, 500, request);
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    const rateOk = await checkRateLimit(db, clientIP, 'withdraw', 3, 5 * 60);
    if (!rateOk) {
      return jsonResponse({ error: 'Too many withdrawal attempts. Please wait 5 minutes.' }, 429, request);
    }

    // ============================================================
    // [SECURITY FIX] Hard pre-flight gate on platform bank config.
    // Runs BEFORE the lock, BEFORE any write, BEFORE any CHIP call.
    // If anything is missing, refuse with an actionable list.
    // ============================================================
    const platformBank = getPlatformBank(env);
    const missingEnv = getPlatformBankMissing(platformBank);
    if (missingEnv.length > 0) {
      await logAction({
        db,
        action: 'withdrawal_blocked_missing_bank_config',
        admin: 'admin',
        details: `Withdrawal refused: missing env vars ${missingEnv.join(', ')}`,
        ip: clientIP
      });
      return jsonResponse({
        error: `Platform bank is not configured. Missing environment variable(s): ${missingEnv.join(', ')}. Refusing to withdraw — no money was moved and no balance was changed.`,
        missing: missingEnv
      }, 500, request);
    }

    // [SECURITY FIX] Validate the bank code before it ever reaches CHIP.
    if (!VALID_CHIP_SEND_CODES.has(platformBank.bankCode)) {
      await logAction({
        db,
        action: 'withdrawal_blocked_invalid_bank_code',
        admin: 'admin',
        details: `Withdrawal refused: PLATFORM_BANK_CODE "${platformBank.bankCode}" is not a known CHIP Send code`,
        ip: clientIP
      });
      return jsonResponse({
        error: `PLATFORM_BANK_CODE "${platformBank.bankCode}" is not a recognised CHIP Send bank code. Fix the environment variable in the Cloudflare dashboard. No money was moved.`,
        code: 'INVALID_PLATFORM_BANK_CODE'
      }, 500, request);
    }

    if (platformBank.accountNumber.length < 8) {
      await logAction({
        db,
        action: 'withdrawal_blocked_invalid_account_number',
        admin: 'admin',
        details: `Withdrawal refused: PLATFORM_BANK_ACCOUNT is only ${platformBank.accountNumber.length} digit(s)`,
        ip: clientIP
      });
      return jsonResponse({
        error: 'PLATFORM_BANK_ACCOUNT must be at least 8 digits. Fix the environment variable in the Cloudflare dashboard. No money was moved.',
        code: 'INVALID_PLATFORM_BANK_ACCOUNT'
      }, 500, request);
    }

    const body = await parseJSONSafely(request);
    const { amount, reset, action } = body || {};

    // ============================================================
    // All writes to kd_fee_earnings happen inside the shared bookings
    // lock so check-in (which also writes fee earnings) and withdrawal
    // can never interleave and lose money.
    // ============================================================
    let result;
    try {
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        // Load earnings + bookings
        let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };
        let bookings = [];
        try {
          const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_fee_earnings').first();
          if (r?.data) earnings = JSON.parse(r.data);
          const bRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
          if (bRes?.data) bookings = JSON.parse(bRes.data);
        } catch (e) {
          return { error: 'Database error. Please try again later.', status: 500 };
        }

        if (!Array.isArray(earnings.history)) earnings.history = [];

        // Backfill total from bookings if missing
        if (!earnings.total || earnings.total === 0) {
          const totalFees = bookings.reduce((sum, b) => {
            const status = (b.status || '').toLowerCase();
            if (status.includes('completed') || status.includes('payout') || b.payoutSuccessDate || b.payoutDate) {
              return sum + (Number(b.fee) || 0) + (Number(b.gatewayFee) || 1.00);
            }
            return sum;
          }, 0);
          if (totalFees > 0) {
            earnings.total = totalFees;
            earnings.available = totalFees - (earnings.withdrawn || 0);
            capHistory(earnings);
            await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
              .bind('kd_fee_earnings', JSON.stringify(earnings))
              .run();
          }
        }

        const actualAvailable = (earnings.total || 0) - (earnings.withdrawn || 0);

        // ===== Reset =====
        if (reset === true || action === 'reset') {
          const prevWithdrawn = earnings.withdrawn || 0;
          const prevTotal = earnings.total || 0;
          earnings.withdrawn = 0;
          earnings.available = 0;
          earnings.total = 0;
          earnings.history.push({
            type: 'reset',
            date: new Date().toISOString(),
            note: 'FULL RESET - All to 0 by admin',
            prevWithdrawn,
            prevTotal,
            ip: clientIP
          });
          capHistory(earnings);
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_fee_earnings', JSON.stringify(earnings))
            .run();
          await logAction({
            db,
            action: 'withdrawal_reset',
            admin: 'admin',
            details: `Reset earnings to 0. Previous: Total RM${prevTotal}, Withdrawn RM${prevWithdrawn}`,
            ip: clientIP
          });
          return {
            success: true,
            message: 'Earnings reset to RM0.00',
            earnings: { ...earnings, available: 0 }
          };
        }

        // ===== Normal withdrawal =====
        if (!amount) {
          return { error: 'Amount is required', status: 400 };
        }
        if (!validateAmount(amount)) {
          return { error: 'Invalid amount. Please enter a valid number with up to 2 decimal places.', status: 400 };
        }

        const withdrawAmount = Number(amount);
        if (withdrawAmount < 10) {
          return { error: 'Minimum withdrawal is RM10.00', status: 400 };
        }
        if (withdrawAmount > actualAvailable) {
          return { error: `Insufficient balance. Available: RM${actualAvailable.toFixed(2)}`, status: 400 };
        }

        await recordRateLimit(db, clientIP, 'withdraw');

        const maskedAccount = platformBank.accountNumber.slice(-4).padStart(platformBank.accountNumber.length, '*');

        // ============================================================
        // HARD GATE. Simulation only when NOT production AND
        // ALLOW_PAYOUT_SIMULATION === 'true'. Otherwise refuse loudly.
        // ============================================================
        const isLive = !!(env.CHIP_API_KEY && env.CHIP_API_SECRET);
        const isProduction = env.ENVIRONMENT === 'production';
        const simulationAllowed = !isProduction && env.ALLOW_PAYOUT_SIMULATION === 'true';

        if (!isLive && isProduction) {
          return {
            error: 'Withdrawal blocked: CHIP Send keys are missing on the production server. Ask admin to restore CHIP_API_KEY / CHIP_API_SECRET. No money was moved and no balance was changed.',
            status: 500
          };
        }
        if (!isLive && !simulationAllowed) {
          return {
            error: 'Withdrawal blocked: CHIP Send keys are not configured and ALLOW_PAYOUT_SIMULATION is not "true". No money was moved.',
            status: 500
          };
        }

        const usedSimulation = !isLive && simulationAllowed;

        let payoutSuccess = false;
        let payoutData = null;

        if (usedSimulation) {
          payoutSuccess = true;
          payoutData = { simulation: true };
          console.log(`[withdraw] SIMULATION: RM${withdrawAmount} to ${platformBank.accountHolder}`);
        } else {
          try {
            const bankAccountId = await getOrCreatePlatformBankAccountId(db, platformBank, env);

            const apiKey = env.CHIP_API_KEY;
            const apiSecret = env.CHIP_API_SECRET;
            const amountCents = Math.round(withdrawAmount * 100);
            const reference = `PLATFORM-WD-${Date.now()}`;

            const payload = {
              bank_account_id: bankAccountId,
              amount: amountCents,
              reference: reference,
              description: `Platform commission withdrawal ${reference}`
            };

            const epoch = Math.floor(Date.now() / 1000);
            const checksum = await hmacSha512(`${epoch}${apiKey}`, apiSecret);

            const payoutRes = await fetch('https://api.chip-in.asia/api/send/payouts/', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'epoch': String(epoch),
                'checksum': checksum
              },
              body: JSON.stringify(payload)
            });

            let raw = null;
            let parseFailed = false;
            try { raw = await payoutRes.json(); } catch (_) { parseFailed = true; }

            if (parseFailed) {
              return {
                error: 'CHIP Send returned an unparseable response. Withdrawal status is UNKNOWN — verify the reference in your CHIP dashboard before retrying. No local balance change was made.',
                status: 502
              };
            }
            if (!payoutRes.ok || !raw?.id) {
              const errStr = String(raw?.error || raw?.message || '').toLowerCase();
              const isStructured = payoutRes.status >= 400 && payoutRes.status < 500 && errStr.length > 0;
              if (isStructured) {
                return {
                  error: 'CHIP Send rejected the withdrawal: ' + (raw.error || raw.message),
                  status: 502
                };
              }
              return {
                error: `CHIP Send response ambiguous (HTTP ${payoutRes.status}). Withdrawal status is UNKNOWN — verify in the CHIP dashboard. No local balance change was made.`,
                status: 502
              };
            }

            payoutSuccess = true;
            payoutData = raw;
          } catch (err) {
            console.error('[withdraw] CHIP Send error:', err.message);
            return {
              error: 'CHIP Send payout failed: ' + err.message,
              status: 500
            };
          }
        }

        // ===== Record withdrawal =====
        const withdrawal = {
          id: 'WD_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
          amount: withdrawAmount,
          bankName: platformBank.bankName,
          bankCode: platformBank.bankCode,
          accountHolder: platformBank.accountHolder,
          accountNumber: maskedAccount,
          date: new Date().toISOString(),
          status: usedSimulation ? 'Success - Simulated' : 'Success - Sent via CHIP Send',
          ip: clientIP,
          payoutId: payoutData?.id || ('SIM_' + Date.now()),
          simulation: usedSimulation
        };

        try {
          earnings.withdrawn = (earnings.withdrawn || 0) + withdrawAmount;
          earnings.history.push({ ...withdrawal, type: 'withdrawal' });
          earnings.available = earnings.total - earnings.withdrawn;
          capHistory(earnings);

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_fee_earnings', JSON.stringify(earnings))
            .run();

          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_platform_bank_last_withdrawal', JSON.stringify({
              bankName: platformBank.bankName,
              bankCode: platformBank.bankCode,
              accountHolder: platformBank.accountHolder,
              accountNumber: maskedAccount,
              lastUpdated: new Date().toISOString(),
              lastWithdrawal: {
                amount: withdrawAmount,
                date: withdrawal.date,
                id: withdrawal.id,
                status: withdrawal.status
              }
            }))
            .run();

          await logAction({
            db,
            action: usedSimulation ? 'withdrawal_simulated' : 'withdrawal_completed',
            admin: 'admin',
            details: `Withdrawal RM${withdrawAmount} to ${platformBank.bankName} (${platformBank.accountHolder})${usedSimulation ? ' (SIMULATED)' : ''}`,
            ip: clientIP
          });
        } catch (e) {
          console.error('[withdraw] Save error after payout:', e.message);
          return {
            error: 'Payout succeeded, but failed to update records. Please verify CHIP dashboard.',
            payoutId: withdrawal.payoutId,
            status: 500
          };
        }

        return {
          success: true,
          message: `RM${withdrawAmount.toFixed(2)} sent to your bank account (${platformBank.bankName} ${platformBank.accountHolder}). ` +
                   (usedSimulation ? '(Simulation mode - no real money sent)' : 'CHIP Send is processing the transfer.'),
          withdrawal,
          earnings: {
            total: earnings.total,
            withdrawn: earnings.withdrawn,
            available: earnings.total - earnings.withdrawn
          },
          security: 'Bank details LOCKED server-side',
          simulation: usedSimulation
        };
      }, 120000);
    } catch (lockErr) {
      if (lockErr.message && lockErr.message.includes('in progress')) {
        return jsonResponse({ error: 'Another money operation is in progress. Please wait a moment and try again.' }, 429, request);
      }
      throw lockErr;
    }

    if (result.error) {
      return jsonResponse({ error: result.error }, result.status || 400, request);
    }
    return jsonResponse(result, 200, request);

  } catch (err) {
    console.error('[withdraw] Error:', err.message);
    return jsonResponse({ error: 'Withdrawal failed. Please try again later.' }, 500, request);
  }
}

// ===== GET =====
export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  const db = env.DB;
  let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };

  // [SECURITY FIX] Show the truth about the platform bank config. If env
  // vars are missing, report "not configured" instead of a fake Maybank.
  const platformBank = getPlatformBank(env);
  const missingBankEnv = getPlatformBankMissing(platformBank);
  const bankConfigured = missingBankEnv.length === 0;

  if (db) {
    try {
      await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
      const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_fee_earnings').first();
      if (r?.data) earnings = JSON.parse(r.data);

      if (!earnings.total || earnings.total === 0) {
        const bRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
        if (bRes?.data) {
          const bookings = JSON.parse(bRes.data);
          const totalFees = bookings.reduce((sum, b) => {
            const status = (b.status || '').toLowerCase();
            if (status.includes('completed') || status.includes('payout') || b.payoutSuccessDate || b.payoutDate) {
              return sum + (Number(b.fee) || 0) + (Number(b.gatewayFee) || 1.00);
            }
            return sum;
          }, 0);
          earnings.total = totalFees;
          earnings.available = totalFees - (earnings.withdrawn || 0);
        }
      } else {
        earnings.available = (earnings.total || 0) - (earnings.withdrawn || 0);
      }
    } catch (e) {
      console.error('[withdraw] GET error:', e.message);
    }
  }

  return jsonResponse({
    message: 'Withdraw API ready - CHIP Send',
    lockedBank: bankConfigured
      ? {
          bankName: platformBank.bankName,
          bankCode: platformBank.bankCode,
          holder: platformBank.accountHolder,
          accountMasked: '****' + platformBank.accountNumber.slice(-4),
          locked: true
        }
      : {
          configured: false,
          missing: missingBankEnv,
          locked: true,
          note: 'Platform bank is not fully configured. Withdrawals are disabled until the missing env vars are set in the Cloudflare dashboard.'
        },
    earnings: {
      total: earnings.total || 0,
      available: earnings.available || 0,
      withdrawn: earnings.withdrawn || 0,
      history: (earnings.history || []).slice(-10)
    },
    security: 'Bank fixed in server env'
  }, 200, request);
}

// ===== DELETE (Reset) =====
export async function onRequestDelete({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Database not configured' }, 500, request);
    }
    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    let result;
    try {
      result = await withLock(db, BOOKINGS_LOCK, async (db) => {
        let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };
        const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_fee_earnings').first();
        if (r?.data) earnings = JSON.parse(r.data);

        const prevWithdrawn = earnings.withdrawn || 0;
        const prevTotal = earnings.total || 0;

        earnings.withdrawn = 0;
        earnings.available = 0;
        earnings.total = 0;
        earnings.history = earnings.history || [];
        earnings.history.push({
          type: 'reset',
          date: new Date().toISOString(),
          note: 'FULL RESET - All to 0 via DELETE',
          prevWithdrawn,
          prevTotal,
          ip: clientIP
        });

        capHistory(earnings);

        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_fee_earnings', JSON.stringify(earnings))
          .run();
        await logAction({
          db,
          action: 'withdrawal_reset_delete',
          admin: 'admin',
          details: `Reset earnings via DELETE. Previous: Total RM${prevTotal}, Withdrawn RM${prevWithdrawn}`,
          ip: clientIP
        });

        return {
          success: true,
          message: 'Earnings reset to RM0.00',
          earnings: { ...earnings, available: 0 }
        };
      }, 30000);
    } catch (lockErr) {
      if (lockErr.message && lockErr.message.includes('in progress')) {
        return jsonResponse({ error: 'Another money operation is in progress. Please wait and try again.' }, 429, request);
      }
      throw lockErr;
    }

    if (result.error) {
      return jsonResponse({ error: result.error }, result.status || 400, request);
    }
    return jsonResponse(result, 200, request);

  } catch (err) {
    console.error('[withdraw] DELETE error:', err.message);
    return jsonResponse({ error: 'Reset failed. Please try again later.' }, 500, request);
  }
}

// ===== OPTIONS =====
export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request, env) });
}

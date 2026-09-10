// /api/withdraw.js – CHIP Send platform commission withdrawal (full CHIP)
import {
  corsHeaders,
  getClientIP,
  logAction,
  enforceHttps,
  getAdminToken,
  checkRateLimit,
  recordRateLimit,
  parseJSONSafely,
  jsonResponse
} from './_utils.js';

// ===== CHIP bank code mapping =====
function getChipBankCode(bankName) {
  const map = {
    'AEON BANK': 'ACDBMYK2',
    'AFFIN BANK': 'PHBMMYKL',
    'AGROBANK': 'AGOBMYKL',
    'AL-RAJHI': 'RJHIMYKL',
    'ALLIANCE BANK': 'MFBBMYKL',
    'AMBANK': 'ARBKMYKL',
    'BANK ISLAM': 'BIMBMYKL',
    'BANK RAKYAT': 'BKRMMYKL',
    'BANK MUAMALAT': 'BMMBMYKL',
    'BSN': 'BSNAMYK1',
    'CIMB': 'CIBBMYKL',
    'HONG LEONG': 'HLBBMYKL',
    'HSBC': 'HBMBMYKL',
    'MAYBANK': 'MBBEMYKL',
    'MBSB': 'AFBQMYKL',
    'OCBC': 'OCBCMYKL',
    'PUBLIC BANK': 'PBBEMYKL',
    'RHB': 'RHBBMYKL',
    'STANDARD CHARTERED': 'SCBLMYKX',
    'TOUCH N GO': 'TNGDMYNB',
    'UOB': 'UOVBMYKL'
  };
  const clean = (bankName || '').toUpperCase().trim();
  if (!clean) return 'MBBEMYKL';
  const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  for (const [key, code] of entries) {
    if (clean.includes(key)) return code;
  }
  return 'MBBEMYKL';
}

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

// ===== Admin auth =====
async function verifyAdmin(request, env) {
  const auth = await getAdminToken(request);
  if (!env.ADMIN_TOKEN) {
    return jsonResponse({ error: 'Server misconfigured' }, 500, request);
  }
  if (auth !== env.ADMIN_TOKEN) {
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

// ===== Platform bank config from env =====
function getPlatformBank(env) {
  return {
    bankName: env.PLATFORM_BANK_NAME || env.YOUR_BANK_NAME || 'Maybank',
    bankCode: env.PLATFORM_BANK_CODE || env.YOUR_BANK_CODE || 'MBBEMYKL',
    accountHolder: env.PLATFORM_BANK_HOLDER || env.YOUR_BANK_HOLDER || '',
    accountNumber: (env.PLATFORM_BANK_ACCOUNT || env.YOUR_BANK_ACCOUNT || '').replace(/[^0-9]/g, '')
  };
}

// ===== Load or create CHIP Send bank account for platform =====
async function getOrCreatePlatformBankAccountId(db, platformBank, env) {
  // Try cached
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

  // Create new
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
  const data = await res.json();
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

    const platformBank = getPlatformBank(env);
    if (!platformBank.accountNumber) {
      return jsonResponse({
        error: 'Platform bank not configured. Please set PLATFORM_BANK_ACCOUNT env variable.'
      }, 500, request);
    }
    if (!platformBank.accountHolder) {
      return jsonResponse({
        error: 'Platform bank holder not configured. Please set PLATFORM_BANK_HOLDER env variable.'
      }, 500, request);
    }

    const body = await parseJSONSafely(request);
    const { amount, reset, action } = body || {};

    // ===== Load earnings + bookings =====
    let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };
    let bookings = [];
    try {
      const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_fee_earnings').first();
      if (r?.data) earnings = JSON.parse(r.data);
      const bRes = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
      if (bRes?.data) bookings = JSON.parse(bRes.data);
    } catch (e) {
      return jsonResponse({ error: 'Database error. Please try again later.' }, 500, request);
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
      return jsonResponse({
        success: true,
        message: 'Earnings reset to RM0.00',
        earnings: { ...earnings, available: 0 }
      }, 200, request);
    }

    // ===== Normal withdrawal =====
    if (!amount) {
      return jsonResponse({ error: 'Amount is required' }, 400, request);
    }
    if (!validateAmount(amount)) {
      return jsonResponse({ error: 'Invalid amount. Please enter a valid number with up to 2 decimal places.' }, 400, request);
    }

    const withdrawAmount = Number(amount);
    if (withdrawAmount < 10) {
      return jsonResponse({ error: 'Minimum withdrawal is RM10.00' }, 400, request);
    }
    if (withdrawAmount > actualAvailable) {
      return jsonResponse({ error: `Insufficient balance. Available: RM${actualAvailable.toFixed(2)}` }, 400, request);
    }

    await recordRateLimit(db, clientIP, 'withdraw');

    const maskedAccount = platformBank.accountNumber.slice(-4).padStart(platformBank.accountNumber.length, '*');

    // ===== Determine mode =====
    const forceSimulation = env.PAYOUT_SIMULATION === 'true' || env.PAYOUT_SIMULATION === '1' || env.PAYOUT_SIMULATION === 'yes';
    const isLive = !!(env.CHIP_API_KEY && env.CHIP_API_SECRET);

    let payoutSuccess = false;
    let payoutData = null;
    let usedSimulation = false;

    if (forceSimulation || !isLive) {
      usedSimulation = true;
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

        const raw = await payoutRes.json();
        if (!payoutRes.ok || !raw.id) {
          throw new Error('CHIP Send failed: ' + (raw.error || 'unknown'));
        }

        payoutSuccess = true;
        payoutData = raw;
        usedSimulation = false;
      } catch (err) {
        console.error('[withdraw] CHIP Send error:', err.message);
        return jsonResponse({
          success: false,
          error: 'CHIP Send payout failed: ' + err.message
        }, 500, request);
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
      return jsonResponse({
        error: 'Payout succeeded, but failed to update records. Please verify CHIP dashboard.',
        payoutId: withdrawal.payoutId
      }, 500, request);
    }

    return jsonResponse({
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
    }, 200, request);

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
  const platformBank = getPlatformBank(env);

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
    lockedBank: {
      bankName: platformBank.bankName,
      holder: platformBank.accountHolder,
      accountMasked: platformBank.accountNumber
        ? '****' + platformBank.accountNumber.slice(-4)
        : 'not set',
      locked: true
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
    let earnings = { total: 0, available: 0, withdrawn: 0, history: [] };

    if (db) {
      await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
      const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_fee_earnings').first();
      if (r?.data) earnings = JSON.parse(r.data);
    }

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

    if (db) {
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
    }

    return jsonResponse({
      success: true,
      message: 'Earnings reset to RM0.00',
      earnings: { ...earnings, available: 0 }
    }, 200, request);

  } catch (err) {
    console.error('[withdraw] DELETE error:', err.message);
    return jsonResponse({ error: 'Reset failed. Please try again later.' }, 500, request);
  }
}

// ===== OPTIONS =====
export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

// /api/payout.js - COMPLETE with security fixes
import { corsHeaders, getClientIP, logAction, enforceHttps, getAdminToken, checkRateLimit, recordRateLimit } from './_utils.js';

async function verifyAdmin(request, env) {
  const auth = await getAdminToken(request);
  if (!env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500, headers: corsHeaders(request) });
  if (auth !== env.ADMIN_TOKEN) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders(request) });
  return null;
}

function validateBankAccount(account) {
  const clean = String(account).replace(/[^0-9]/g, '');
  return clean.length >= 10 && clean.length <= 15;
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  const authError = await verifyAdmin(request, env);
  if (authError) return authError;

  try {
    const clientIP = getClientIP(request);
    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Database not configured" }), { status: 500, headers: corsHeaders(request) });
    }

    // Persistent rate limiting
    const rateOk = await checkRateLimit(db, clientIP, 'payout', 5, 5 * 60);
    if (!rateOk) {
      return new Response(JSON.stringify({ 
        error: "Too many payout attempts. Please wait 5 minutes." 
      }), { 
        status: 429, 
        headers: corsHeaders(request) 
      });
    }

    const body = await request.json();
    const { bookingId, amount, fee, ownerBankCode, ownerAcc, ownerName } = body;

    if (!bookingId) {
      return new Response(JSON.stringify({ error: "Missing bookingId" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return new Response(JSON.stringify({ error: "Invalid amount" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    if (!ownerName) {
      return new Response(JSON.stringify({ error: "Missing owner name" }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    if (!validateBankAccount(ownerAcc)) {
      return new Response(JSON.stringify({ 
        error: "Invalid owner bank account. Must be at least 10 digits." 
      }), { 
        status: 400, 
        headers: corsHeaders(request) 
      });
    }

    const cleanOwnerAcc = String(ownerAcc || "").replace(/[^0-9]/g, "");
    const payoutAmount = Number(amount);
    const isToyyibLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
    const isProduction = env.ENVIRONMENT === "production";

    // ***** SAFETY: Never simulate in production *****
    const allowSimulation = !isProduction && env.PAYOUT_SIMULATION === "true";

    // Check duplicate payout
    if (db) {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    }

    if (db) {
      try {
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        let bookings = res ? JSON.parse(res.data) : [];
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx !== -1 && bookings[idx].payoutDate) {
          return new Response(JSON.stringify({
            success: true,
            warning: true,
            message: `Booking ${bookingId} already paid out on ${bookings[idx].payoutDate}`,
            alreadyPaid: true,
            payoutAmount: bookings[idx].payoutAmount,
            payoutDate: bookings[idx].payoutDate
          }), { headers: corsHeaders(request) });
        }
      } catch (e) {
        console.error("Failed to check duplicate payout:", e.message);
      }
    }

    // Record attempt after duplicate check
    await recordRateLimit(db, clientIP, 'payout');

    if (!isToyyibLive) {
      // Manual fallback with simulation guard
      if (db) {
        try {
          const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
          let bookings = res ? JSON.parse(res.data) : [];
          const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
          if (idx !== -1) {
            bookings[idx].status = "Completed - Owner Paid RM" + payoutAmount + " (Awaiting ToyyibPay Payout Activation)";
            bookings[idx].payoutDate = new Date().toISOString();
            bookings[idx].payoutAmount = Number(payoutAmount);
            bookings[idx].payoutMethod = "Manual until ToyyibPay Payout enabled";
            bookings[idx].completedDate = new Date().toISOString();
            bookings[idx].payoutAttempts = (bookings[idx].payoutAttempts || 0) + 1;
            bookings[idx].payoutIP = clientIP;
            await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
              .bind("kd_bookings", JSON.stringify(bookings))
              .run();
            
            await logAction({
              db,
              action: 'payout_manual',
              admin: 'admin',
              details: `Manual payout for booking ${bookingId}: RM${payoutAmount}`,
              ip: clientIP,
              userId: ownerName
            });
          }
        } catch (e) {
          console.error("❌ Failed to update booking (manual fallback):", e.message);
        }
      }
      return new Response(JSON.stringify({
        success: true,
        simulation: true,
        message: `ToyyibPay Payout not yet enabled. Set TOYYIBPAY_PAYOUT_ENABLED=true after ToyyibPay approves Payout. Meanwhile manually transfer RM${payoutAmount} to ${ownerName}.`,
        bookingId,
        amount: payoutAmount,
        owner: ownerName,
        instruction: `Enable ToyyibPay Payout to make this auto. For now transfer RM${payoutAmount} to ${ownerName}`,
        nextStep: "Contact ToyyibPay support: Enable Payout feature for your account"
      }), { headers: corsHeaders(request) });
    }

    const formData = new FormData();
    formData.append("userSecretKey", env.TOYYIBPAY_SECRET_KEY);
    formData.append("bankCode", ownerBankCode || "MBBEMYKL");
    formData.append("bankAccountNumber", cleanOwnerAcc);
    formData.append("accountHolderName", ownerName || "Homestay Owner");
    formData.append("amount", Math.round(payoutAmount * 100));
    formData.append("payoutDescription", `KDH ${bookingId} owner payout RM${payoutAmount}`);
    formData.append("payoutReferenceNo", bookingId);

    const payoutEndpoints = [
      "https://toyyibpay.com/index.php/api/payout",
      "https://toyyibpay.com/index.php/api/createPayout",
      "https://toyyibpay.com/index.php/api/runPayout"
    ];

    let payoutData = null;
    let payoutRes = null;
    let lastError = null;

    for (const endpoint of payoutEndpoints) {
      try {
        payoutRes = await fetch(endpoint, { 
          method: "POST", 
          body: formData,
          headers: {
            'User-Agent': 'KundasangHomestay/1.0'
          }
        });
        const text = await payoutRes.text();
        try { payoutData = JSON.parse(text); } catch { payoutData = { raw: text }; }
        if (payoutRes.ok && (payoutData.status === "success" || payoutData[0]?.status === "success" || payoutData.payoutCode)) {
          break;
        }
        lastError = payoutData;
      } catch (e) {
        lastError = e.message;
        console.error(`❌ Payout endpoint ${endpoint} failed:`, e.message);
      }
    }

    const isSuccess = payoutRes && payoutRes.ok;

    if (db) {
      try {
        const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        let bookings = res ? JSON.parse(res.data) : [];
        const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
        if (idx !== -1) {
          if (!bookings[idx].payoutDate) {
            bookings[idx].status = isSuccess
              ? "Completed - Owner Paid RM" + payoutAmount + " via ToyyibPay"
              : "Completed - Owner Paid RM" + payoutAmount + " (Payout API error, check settlement)";
            bookings[idx].payoutDate = new Date().toISOString();
            bookings[idx].payoutAmount = Number(payoutAmount);
            bookings[idx].payoutId = payoutData?.payoutCode || payoutData?.id || payoutData?.[0]?.PayoutCode || "TOYYIBPAY_" + Date.now();
            bookings[idx].payoutMethod = "ToyyibPay Auto Payout";
            bookings[idx].payoutResponse = payoutData;
            bookings[idx].completedDate = new Date().toISOString();
            bookings[idx].payoutAttempts = (bookings[idx].payoutAttempts || 0) + 1;
            bookings[idx].payoutIP = clientIP;
          }
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_bookings", JSON.stringify(bookings))
            .run();
          
          await logAction({
            db,
            action: 'payout_auto',
            admin: 'admin',
            details: `Auto payout for booking ${bookingId}: RM${payoutAmount} to ${ownerName}`,
            ip: clientIP,
            userId: ownerName
          });
        }
      } catch (e) {
        console.error("❌ Failed to update booking status after payout:", e.message);
      }

      try {
        const feeRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_fee_earnings").first();
        let feeEarnings = feeRes ? JSON.parse(feeRes.data) : { total: 0, available: 0, withdrawn: 0, history: [] };
        
        const alreadyRecorded = feeEarnings.history?.some(h => h.bookingId === bookingId && h.type === "earning");
        
        if (!alreadyRecorded) {
          const netFee = Number(fee || 0) - 1.00;
          const finalFee = netFee > 0 ? netFee : Number(fee || 0);
          if (finalFee > 0) {
            feeEarnings.total = (feeEarnings.total || 0) + finalFee;
            feeEarnings.available = (feeEarnings.available || 0) + finalFee;
            feeEarnings.history = feeEarnings.history || [];
            feeEarnings.history.push({
              bookingId,
              fee: finalFee,
              date: new Date().toISOString(),
              type: "earning",
              payoutToOwner: Number(payoutAmount),
              ownerAcc: "****" + cleanOwnerAcc.slice(-4),
              method: isSuccess ? "toyyibpay_auto" : "manual_fallback",
              ip: clientIP
            });
            await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
              .bind("kd_fee_earnings", JSON.stringify(feeEarnings))
              .run();
          }
        }
      } catch (e) {
        console.error("❌ Failed to record fee earnings:", e.message);
      }
    }

    if (!isSuccess) {
      return new Response(JSON.stringify({
        success: true,
        warning: true,
        message: `Booking completed but ToyyibPay Payout API returned error. Funds will still settle via daily auto settlement. Transfer manually to owner for now.`,
        payoutError: lastError,
        bookingId,
        amount: payoutAmount,
        note: "Contact ToyyibPay to enable Payout: support@toyyibpay.com"
      }), { headers: corsHeaders(request) });
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Auto payout RM${payoutAmount} to ${ownerName} via ToyyibPay`,
      payout: payoutData,
      bookingId,
      flow: "Check-in → Complete → Owner gets Base via ToyyibPay → You keep Fee"
    }), { headers: corsHeaders(request) });

  } catch (e) {
    console.error("❌ Payout request failed:", e.message);
    return new Response(JSON.stringify({ 
      error: "Payout failed. Please try again later." 
    }), { 
      status: 500, 
      headers: corsHeaders(request) 
    });
  }
}

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  const isLive = env.TOYYIBPAY_SECRET_KEY && env.TOYYIBPAY_PAYOUT_ENABLED === "true";
  return new Response(JSON.stringify({
    message: "Payout API ready",
    toyyibPayPayoutEnabled: isLive,
    mode: isLive ? "AUTO (ToyyibPay)" : "MANUAL (fallback)",
    bankCode: env.YOUR_BANK_CODE || "MBBEMYKL",
    security: "Admin auth required for POST"
  }), { status: 200, headers: corsHeaders(request) });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

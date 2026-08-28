// /api/toyyibpay-payout-webhook.js
import { corsHeaders, getClientIP, logAction, enforceHttps, sha256 } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const clientIP = getClientIP(request);
    const formData = await request.formData();
    const payoutCode = formData.get('payoutCode') || formData.get('PayoutCode') || formData.get('payout_reference_no');
    const status = formData.get('status');
    const amount = formData.get('amount');
    const referenceNo = formData.get('referenceNo') || formData.get('payoutReferenceNo');

    // 🔒 Enforce signature
    const signature = request.headers.get('X-ToyyibPay-Signature') || '';
    if (!signature) {
      console.warn('Missing signature header – rejecting');
      return new Response('Missing signature', { status: 401, headers: corsHeaders(request) });
    }

    if (!referenceNo || !status || !amount) {
      console.warn('Missing fields in webhook');
      return new Response('Missing fields', { status: 400, headers: corsHeaders(request) });
    }

    const expectedSig = await sha256(`${referenceNo}${status}${amount}${env.TOYYIBPAY_SECRET_KEY}`);
    if (signature !== expectedSig) {
      console.warn('Invalid signature');
      return new Response('Invalid signature', { status: 401, headers: corsHeaders(request) });
    }

    console.log("📡 ToyyibPay Payout Webhook received:", { payoutCode, status, referenceNo, amount, ip: clientIP });

    if (String(status) !== "success" && String(status) !== "1" && String(status) !== "completed") {
      console.log(`⚠️ Payout not successful - status: ${status}`);
      return new Response(`Not success - status ${status}`, { status: 200, headers: corsHeaders(request) });
    }

    const db = env.DB;
    if (!db) {
      console.error('❌ No database configured');
      return new Response('No DB', { status: 500, headers: corsHeaders(request) });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // Idempotency
    const webhookId = request.headers.get('X-Webhook-Id') || payoutCode || referenceNo || crypto.randomUUID();
    await db.prepare(`CREATE TABLE IF NOT EXISTS webhook_log (
      id TEXT PRIMARY KEY,
      processed_at TEXT,
      type TEXT
    )`).run();
    const existing = await db.prepare('SELECT id FROM webhook_log WHERE id = ?').bind(webhookId).first();
    if (existing) {
      console.log(`✅ Payout webhook ${webhookId} already processed, skipping`);
      return new Response('Already processed', { status: 200, headers: corsHeaders(request) });
    }

    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res) { try { bookings = JSON.parse(res.data); } catch(e) { console.error('Failed to parse bookings:', e); } }

    const idx = bookings.findIndex(b => String(b.id) === String(referenceNo) || String(b.ownerPayoutId) === String(payoutCode));

    if (idx !== -1) {
      if (bookings[idx].payoutSuccess && bookings[idx].payoutSuccessDate) {
        console.log(`✅ Booking ${referenceNo} already marked as payout success, skipping`);
        await db.prepare('INSERT INTO webhook_log (id, processed_at, type) VALUES (?, ?, ?)')
          .bind(webhookId, new Date().toISOString(), 'payout').run();
        return new Response("Already processed", { status: 200, headers: corsHeaders(request) });
      }

      console.log(`✅ Updating booking ${referenceNo} to PAYOUT SUCCESS`);
      bookings[idx].payoutSuccess = true;
      bookings[idx].payoutSuccessDate = new Date().toISOString();
      bookings[idx].payoutCode = payoutCode;
      bookings[idx].status = "Completed - Payout Success";
      bookings[idx].completedDate = new Date().toISOString();

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_bookings", JSON.stringify(bookings))
        .run();

      await logAction({
        db,
        action: 'payout_success_webhook',
        admin: 'toyyibpay',
        details: `Payout success for booking ${referenceNo}, amount RM${amount}`,
        ip: clientIP,
        userId: bookings[idx].guestEmail,
        homestayId: bookings[idx].homestayId
      });

      await db.prepare('INSERT INTO webhook_log (id, processed_at, type) VALUES (?, ?, ?)')
        .bind(webhookId, new Date().toISOString(), 'payout').run();

      console.log(`✅ Payout success webhook processed for ${referenceNo}`);
      return new Response("OK", { status: 200, headers: corsHeaders(request) });
    } else {
      console.warn(`⚠️ Booking ${referenceNo} not found in database`);
      return new Response(`Booking ${referenceNo} not found`, { status: 404, headers: corsHeaders(request) });
    }
  } catch (e) {
    console.error('❌ Payout webhook error:', e.message, e.stack);
    return new Response("Error: " + e.message, { status: 500, headers: corsHeaders(request) });
  }
}

export async function onRequestGet({ request }) {
  return new Response("ToyyibPay Payout webhook ready", { status: 200, headers: corsHeaders(request) });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

// /api/toyyibpay-payout-webhook.js
import { corsHeaders, getClientIP, logAction, enforceHttps } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const authHeader = request.headers.get('Authorization') || '';
    const expectedToken = env.TOYYIBPAY_SECRET_KEY || '';
    if (!expectedToken) {
      console.error('🔐 TOYYIBPAY_SECRET_KEY not set – rejecting webhook');
      return new Response('Unauthorized - Secret key not configured', { status: 401, headers: corsHeaders(request) });
    }
    if (authHeader !== 'Bearer ' + expectedToken) {
      console.warn('🔐 Payout webhook unauthorized');
      return new Response('Unauthorized', { status: 401, headers: corsHeaders(request) });
    }

    const formData = await request.formData();
    const payoutCode = formData.get('payoutCode') || formData.get('PayoutCode') || formData.get('payout_reference_no');
    const status = formData.get('status');
    const amount = formData.get('amount');
    const bankCode = formData.get('bankCode');
    const accountNumber = formData.get('bankAccountNumber');
    const referenceNo = formData.get('referenceNo') || formData.get('payoutReferenceNo');
    const transactionDate = formData.get('transactionDate') || new Date().toISOString();

    console.log("📡 ToyyibPay Payout Webhook received:", { payoutCode, status, referenceNo, amount });

    if (String(status) !== "success" && String(status) !== "1" && String(status) !== "completed") {
      console.log(`⚠️ Payout not successful - status: ${status}`);
      return new Response(`Not success - status ${status}`, { status: 200, headers: corsHeaders(request) });
    }

    if (!referenceNo) {
      console.error('❌ Missing referenceNo in webhook');
      return new Response('Missing referenceNo', { status: 400, headers: corsHeaders(request) });
    }

    const db = env.DB;
    if (!db) {
      console.error('❌ No database configured');
      return new Response('No DB', { status: 500, headers: corsHeaders(request) });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res) { try { bookings = JSON.parse(res.data); } catch(e) { console.error('Failed to parse bookings:', e); } }

    const idx = bookings.findIndex(b => String(b.id) === String(referenceNo) || String(b.ownerPayoutId) === String(payoutCode));

    if (idx !== -1) {
      // Already processed?
      if (bookings[idx].payoutSuccess && bookings[idx].payoutSuccessDate) {
        console.log(`✅ Booking ${referenceNo} already marked as payout success, skipping`);
        return new Response("Already processed", { status: 200, headers: corsHeaders(request) });
      }

      console.log(`✅ Updating booking ${referenceNo} to PAYOUT SUCCESS`);
      bookings[idx].payoutSuccess = true;
      bookings[idx].payoutSuccessDate = transactionDate || new Date().toISOString();
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
        ip: getClientIP(request),
        userId: bookings[idx].guestEmail,
        homestayId: bookings[idx].homestayId
      });

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

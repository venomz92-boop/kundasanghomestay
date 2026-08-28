// /api/check-payment-status.js
import { corsHeaders, enforceHttps, getGuestSession, jsonResponse } from './_utils.js';

function md5(str) {
  // Same MD5 implementation as above (copy it here or import)
  // (I'll assume you copy the md5 function from the webhook file)
  // For brevity, I'll show the logic without the full MD5 code – but you should copy it.
  // Use the same md5() function from the webhook.
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const session = await getGuestSession(request, env);
    if (!session || session.type !== 'guest') {
      return jsonResponse({ error: 'Authentication required' }, 401, request);
    }

    const { bookingId } = await request.json();
    if (!bookingId) {
      return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    }

    const db = env.DB;
    if (!db) {
      return jsonResponse({ error: 'Server error' }, 500, request);
    }

    // 1. Get booking from store
    const result = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (result?.data) bookings = JSON.parse(result.data); } catch(_) {}
    const idx = bookings.findIndex(b => String(b.id) === bookingId);
    if (idx < 0) {
      return jsonResponse({ error: 'Booking not found' }, 404, request);
    }
    const booking = bookings[idx];

    // 2. If already paid, return immediately
    if (booking.status === 'Paid - Awaiting Check-in' || booking.status === 'Completed') {
      return jsonResponse({ success: true, status: booking.status, paid: true }, 200, request);
    }

    // 3. If we have a billcode, query ToyyibPay for status
    const billcode = booking.toyyibpay_billcode;
    if (!billcode) {
      return jsonResponse({ error: 'No billcode found' }, 404, request);
    }

    const secret = env.TOYYIBPAY_SECRET_KEY;
    const apiBase = env.TOYYIBPAY_ENV === 'production' ? 'https://toyyibpay.com' : 'https://dev.toyyibpay.com';
    const url = `${apiBase}/index.php/api/getBillTransactions`;
    const form = new FormData();
    form.append('userSecretKey', secret);
    form.append('billCode', billcode);

    const response = await fetch(url, { method: 'POST', body: form });
    const data = await response.json().catch(() => null);

    if (!Array.isArray(data) || data.length === 0) {
      return jsonResponse({ error: 'No transactions found' }, 404, request);
    }

    // 4. Find the latest transaction (or any with status=1)
    const paidTransaction = data.find(t => String(t.billpaymentStatus) === '1');
    if (!paidTransaction) {
      return jsonResponse({ success: true, status: 'Pending Payment', paid: false }, 200, request);
    }

    // 5. Update booking to paid
    bookings[idx] = {
      ...booking,
      status: 'Paid - Awaiting Check-in',
      paid_at: paidTransaction.billpaymentTransactionTime || new Date().toISOString(),
      toyyibpay_refno: paidTransaction.billpaymentRefNo || '',
      toyyibpay_status: '1',
      toyyibpay_amount: paidTransaction.billpaymentAmount || ''
    };

    await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
      .bind('kd_bookings', JSON.stringify(bookings))
      .run();

    return jsonResponse({ success: true, status: 'Paid - Awaiting Check-in', paid: true }, 200, request);

  } catch (error) {
    console.error('Check status error:', error.message);
    return jsonResponse({ error: 'Failed to check status' }, 500, request);
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

// /api/toyyibpay-webhook.js
import { corsHeaders, enforceHttps, getClientIP, logAction } from './_utils.js';

// =============================================================
// MD5 HASH FUNCTION (for ToyyibPay signature verification)
// =============================================================
function md5(str) {
  const utf8 = new TextEncoder().encode(str);
  const bytes = Array.from(utf8);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((bitLen / Math.pow(2, 8 * i)) & 0xff);

  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < bytes.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = (bytes[off + 4 * i] | (bytes[off + 4 * i + 1] << 8) | (bytes[off + 4 * i + 2] << 16) | (bytes[off + 4 * i + 3] << 24)) >>> 0;
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | ((~B) & D); g = i; } else if (i < 32) { F = (D & B) | ((~D) & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | (~D)); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B; B = (B + rotl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const wordHex = n => Array.from({ length: 4 }, (_, i) => ((n >>> (8 * i)) & 255).toString(16).padStart(2, '0')).join('');
  return wordHex(a0) + wordHex(b0) + wordHex(c0) + wordHex(d0);
}

// =============================================================
// MAIN WEBHOOK HANDLER
// =============================================================
export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    // ---- 1. Parse request body (supports both JSON and form-data) ----
    const contentType = request.headers.get('content-type') || '';
    let data = {};
    if (contentType.includes('application/json')) {
      data = await request.json();
    } else {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        data[key] = String(value);
      }
    }

    // ---- 2. Extract callback parameters ----
    const status = String(data.status || '').trim();
    const orderId = String(data.order_id || '').trim();
    const refno = String(data.refno || '').trim();
    const billcode = String(data.billcode || '').trim();
    const receivedHash = String(data.hash || '').trim();
    const amountRaw = String(data.amount || '0').trim();
    const reason = String(data.reason || '').trim();
    const transactionTime = String(data.transaction_time || '').trim();

    // ---- 3. Validate required fields ----
    if (!orderId || !billcode || !receivedHash) {
      console.error('❌ Missing required fields:', { orderId, billcode, receivedHash });
      return new Response('Missing required fields', { status: 400, headers: corsHeaders(request) });
    }

    // ---- 4. Verify signature ----
    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      console.error('❌ TOYYIBPAY_SECRET_KEY not set');
      return new Response('Server configuration error', { status: 500, headers: corsHeaders(request) });
    }

    // Hash formula: MD5(userSecretKey + status + order_id + refno + "ok")[reference:4]
    const expectedHash = md5(`${secret}${status}${orderId}${refno}ok`);
    if (expectedHash.toLowerCase() !== receivedHash.toLowerCase()) {
      console.error(`❌ Hash mismatch: expected ${expectedHash}, got ${receivedHash}`);
      console.error(`   Data: secret=${secret.substring(0,4)}***, status=${status}, order_id=${orderId}, refno=${refno}`);
      return new Response('Invalid signature', { status: 401, headers: corsHeaders(request) });
    }
    console.log(`✅ Signature verified for order_id=${orderId}, status=${status}`);

    // ---- 5. Connect to database ----
    const db = env.DB;
    if (!db) {
      console.error('❌ DB not available');
      return new Response('DB error', { status: 500, headers: corsHeaders(request) });
    }

    // ---- 6. Retrieve bookings ----
    const result = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try {
      if (result?.data) bookings = JSON.parse(result.data);
    } catch (_) {
      console.error('❌ Failed to parse bookings data');
    }
    if (!bookings.length) {
      console.error('❌ No bookings found in store');
      return new Response('No bookings', { status: 404, headers: corsHeaders(request) });
    }

    // ---- 7. Find booking ----
    // Try exact match first: order_id + billcode
    let idx = bookings.findIndex(b => String(b.id) === orderId && String(b.toyyibpay_billcode || '') === billcode);
    let matchType = 'exact';

    // Fallback: match by order_id only (if billcode not yet stored)
    if (idx < 0) {
      idx = bookings.findIndex(b => String(b.id) === orderId);
      matchType = 'order_id_only';
      if (idx >= 0) {
        console.log(`⚠️ Found booking by order_id only (billcode mismatch): ${orderId}`);
        // Update the booking with the correct billcode
        bookings[idx] = { ...bookings[idx], toyyibpay_billcode: billcode };
      }
    }

    if (idx < 0) {
      console.error(`❌ Booking not found for order_id=${orderId}, billcode=${billcode}`);
      return new Response('Booking not found', { status: 404, headers: corsHeaders(request) });
    }

    const booking = bookings[idx];
    console.log(`✅ Found booking: ${booking.id}, matchType: ${matchType}, currentStatus: ${booking.status}`);

    // ---- 8. Amount validation ----
    // IMPORTANT: amount is already in cents (sen)[reference:5]
    const expectedAmount = Math.round(Number(booking.total) * 100);
    const callbackAmountCents = Math.round(Number(amountRaw));
    if (callbackAmountCents !== expectedAmount) {
      console.error(`❌ Amount mismatch: expected ${expectedAmount} (RM${booking.total}), got ${callbackAmountCents} (${amountRaw})`);
      return new Response('Amount mismatch', { status: 400, headers: corsHeaders(request) });
    }

    // ---- 9. Process based on status ----
    if (status === '1') {
      // SUCCESS
      const currentStatus = String(booking.status || '');
      if (/paid|completed/i.test(currentStatus)) {
        console.log(`ℹ️ Booking ${orderId} already marked as ${currentStatus}, skipping`);
        return new Response('Already processed', { status: 200, headers: corsHeaders(request) });
      }

      bookings[idx] = {
        ...booking,
        status: 'Paid - Awaiting Check-in',
        paid_at: transactionTime || new Date().toISOString(),
        toyyibpay_refno: refno,
        toyyibpay_status: status,
        toyyibpay_reason: reason,
        toyyibpay_amount: amountRaw
      };

      await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      console.log(`✅ Booking ${orderId} updated to PAID`);

      await logAction({
        db,
        action: 'payment_success',
        admin: 'toyyibpay',
        details: `Payment confirmed for ${orderId}, refno: ${refno}, amount: RM${(callbackAmountCents/100).toFixed(2)}`,
        ip: getClientIP(request),
        userId: booking.guestId,
        homestayId: booking.homestayId
      });

      return new Response('OK', { status: 200, headers: corsHeaders(request) });

    } else if (status === '3') {
      // FAILED
      bookings[idx] = {
        ...booking,
        status: 'Payment Failed',
        toyyibpay_refno: refno,
        toyyibpay_status: status,
        toyyibpay_reason: reason,
        toyyibpay_amount: amountRaw
      };

      await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      console.log(`⚠️ Booking ${orderId} marked as PAYMENT FAILED: ${reason}`);

      await logAction({
        db,
        action: 'payment_failed',
        admin: 'toyyibpay',
        details: `Payment failed for ${orderId}, reason: ${reason}`,
        ip: getClientIP(request),
        userId: booking.guestId,
        homestayId: booking.homestayId
      });

      return new Response('OK', { status: 200, headers: corsHeaders(request) });

    } else {
      // status = 2 (pending) or any other
      console.log(`ℹ️ Status ${status} for ${orderId} - not actionable (pending/other)`);
      return new Response('Status ignored', { status: 200, headers: corsHeaders(request) });
    }

  } catch (error) {
    console.error('❌ Webhook error:', error.message, error.stack);
    return new Response('Server error: ' + error.message, { status: 500, headers: corsHeaders(request) });
  }
}

// =============================================================
// GET & OPTIONS HANDLERS
// =============================================================
export async function onRequestGet({ request }) {
  return new Response('ToyyibPay webhook endpoint is ready', { status: 200, headers: corsHeaders(request) });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

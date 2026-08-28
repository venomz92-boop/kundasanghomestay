// /api/toyyibpay-webhook.js
import { corsHeaders, enforceHttps, getClientIP, logAction } from './_utils.js';

// ======== MD5 ========
function md5(str) {
  const utf8 = new TextEncoder().encode(str);
  const bytes = Array.from(utf8);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((bitLen / Math.pow(2, 8 * i)) & 0xff);
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < bytes.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = (bytes[off+4*i] | (bytes[off+4*i+1]<<8) | (bytes[off+4*i+2]<<16) | (bytes[off+4*i+3]<<24)) >>> 0;
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | ((~B) & D); g = i; }
      else if (i < 32) { F = (D & B) | ((~D) & C); g = (5*i+1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3*i+5) % 16; }
      else { F = C ^ (B | (~D)); g = (7*i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B; B = (B + rotl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const wordHex = n => Array.from({ length: 4 }, (_, i) => ((n >>> (8*i)) & 255).toString(16).padStart(2, '0')).join('');
  return wordHex(a0) + wordHex(b0) + wordHex(c0) + wordHex(d0);
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    // 1. Parse body (JSON or form)
    const contentType = request.headers.get('content-type') || '';
    let data = {};
    if (contentType.includes('application/json')) {
      data = await request.json();
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) data[k] = String(v);
    }

    // 2. Log everything (you'll see this in Cloudflare Logs)
    console.log('📥 TOYYIBPAY WEBHOOK');
    console.log('Headers:', Object.fromEntries(request.headers.entries()));
    console.log('Body:', data);

    const status = String(data.status || '').trim();
    const orderId = String(data.order_id || '').trim();
    const refno = String(data.refno || '').trim();
    const billcode = String(data.billcode || '').trim();
    const hash = String(data.hash || '').trim();
    const amountRaw = String(data.amount || '0').trim();
    const reason = String(data.reason || '').trim();
    const transactionTime = String(data.transaction_time || '').trim();

    if (!orderId || !billcode || !hash) {
      console.error('❌ Missing required fields');
      return new Response('Missing fields', { status: 400, headers: corsHeaders(request) });
    }

    // 3. Verify signature
    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      console.error('❌ TOYYIBPAY_SECRET_KEY not set');
      return new Response('Config error', { status: 500, headers: corsHeaders(request) });
    }
    const expected = md5(`${secret}${status}${orderId}${refno}ok`);
    if (expected.toLowerCase() !== hash.toLowerCase()) {
      console.error(`❌ Hash mismatch: expected ${expected}, got ${hash}`);
      return new Response('Invalid signature', { status: 401, headers: corsHeaders(request) });
    }
    console.log(`✅ Signature verified for order_id=${orderId}`);

    // 4. DB
    const db = env.DB;
    if (!db) {
      console.error('❌ DB not available');
      return new Response('DB error', { status: 500, headers: corsHeaders(request) });
    }

    // 5. Get bookings
    const result = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (result?.data) bookings = JSON.parse(result.data); } catch(_) {}
    if (!Array.isArray(bookings)) bookings = [];

    // 6. Find booking by order_id (ignore billcode mismatch)
    let idx = bookings.findIndex(b => String(b.id) === orderId);
    let booking = null;
    if (idx >= 0) {
      booking = bookings[idx];
      console.log(`✅ Found booking: ${booking.id}, current status: ${booking.status}`);
    } else {
      console.warn(`⚠️ Booking ${orderId} not found – will create a temporary record`);
      // Create a placeholder so we can still update
      booking = {
        id: orderId,
        status: 'Pending Payment',
        total: 0,
        guestId: 'unknown',
        homestayId: 'unknown',
        homestay: 'Unknown',
        guestName: 'Guest',
        guestEmail: '',
        guestPhone: ''
      };
      idx = bookings.length;
      bookings.push(booking);
    }

    // 7. Amount check (already in sen)
    const expectedAmount = Math.round(Number(booking.total || 0) * 100);
    const callbackAmountCents = Math.round(Number(amountRaw));
    if (expectedAmount > 0 && callbackAmountCents !== expectedAmount) {
      console.error(`❌ Amount mismatch: expected ${expectedAmount}, got ${callbackAmountCents}`);
      // Still proceed, but log it
    }

    // 8. Update status based on status code
    let updated = false;
    if (status === '1') {
      bookings[idx] = {
        ...booking,
        status: 'Paid - Awaiting Check-in',
        paid_at: transactionTime || new Date().toISOString(),
        toyyibpay_refno: refno,
        toyyibpay_status: status,
        toyyibpay_reason: reason,
        toyyibpay_amount: amountRaw,
        toyyibpay_billcode: billcode
      };
      updated = true;
      console.log(`✅ Booking ${orderId} updated to PAID`);
    } else if (status === '3') {
      bookings[idx] = {
        ...booking,
        status: 'Payment Failed',
        toyyibpay_refno: refno,
        toyyibpay_status: status,
        toyyibpay_reason: reason,
        toyyibpay_amount: amountRaw,
        toyyibpay_billcode: billcode
      };
      updated = true;
      console.log(`⚠️ Booking ${orderId} marked as FAILED`);
    } else {
      console.log(`ℹ️ Status ${status} – ignoring`);
    }

    if (updated) {
      // Save back to DB
      await db.prepare('INSERT OR REPLACE INTO store(key, data) VALUES(?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
      console.log(`💾 Bookings saved`);
    }

    // 9. Log action
    await logAction({
      db,
      action: 'webhook_processed',
      admin: 'toyyibpay',
      details: `Status ${status} for ${orderId}, refno: ${refno}`,
      ip: getClientIP(request),
      userId: booking.guestId,
      homestayId: booking.homestayId
    });

    return new Response('OK', { status: 200, headers: corsHeaders(request) });

  } catch (error) {
    console.error('❌ Webhook error:', error.message, error.stack);
    return new Response('Server error: ' + error.message, { status: 500, headers: corsHeaders(request) });
  }
}

export async function onRequestGet({ request }) {
  return new Response('ToyyibPay webhook endpoint ready', { status: 200, headers: corsHeaders(request) });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

// /api/toyyibpay-webhook.js
import { corsHeaders, getClientIP, logAction } from './_utils.js';

// MD5 function (same as before)
function md5(str) {
  const utf8 = new TextEncoder().encode(str);
  const bytes = Array.from(utf8);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push((bitLen / Math.pow(2, 8 * i)) & 0xff);

  const K = Array.from({length:64}, (_,i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const rotl = (x,c) => ((x << c) | (x >>> (32-c))) >>> 0;
  let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
  for(let off=0; off<bytes.length; off+=64){
    const M = new Uint32Array(16);
    for(let i=0; i<16; i++) M[i] = (bytes[off+4*i] | (bytes[off+4*i+1]<<8) | (bytes[off+4*i+2]<<16) | (bytes[off+4*i+3]<<24)) >>> 0;
    let A=a0, B=b0, C=c0, D=d0;
    for(let i=0; i<64; i++){
      let F, g;
      if(i<16){ F=(B&C)|((~B)&D); g=i; }
      else if(i<32){ F=(D&B)|((~D)&C); g=(5*i+1)%16; }
      else if(i<48){ F=B^C^D; g=(3*i+5)%16; }
      else { F=C^(B|(~D)); g=(7*i)%16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B; B = (B + rotl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const wordHex = n => Array.from({length:4}, (_,i) => ((n>>>(8*i))&255).toString(16).padStart(2,'0')).join('');
  return wordHex(a0) + wordHex(b0) + wordHex(c0) + wordHex(d0);
}

export async function onRequestPost({ request, env }) {
  const ip = getClientIP(request);
  console.log('📡 ToyyibPay webhook called from IP:', ip);

  try {
    // 1. Parse request body (form data or JSON)
    const contentType = request.headers.get('content-type') || '';
    let data = {};
    if (contentType.includes('application/json')) {
      data = await request.json();
    } else {
      const formData = await request.formData();
      for (const [key, value] of formData.entries()) {
        data[key] = String(value);
      }
    }

    console.log('🔍 Webhook received data:', data);

    const status = String(data.status || '');
    const orderId = String(data.order_id || '');
    const refno = String(data.refno || '');
    const billcode = String(data.billcode || '');
    const receivedHash = String(data.hash || '');

    if (!orderId || !billcode || !receivedHash) {
      console.error('❌ Missing fields in webhook:', { orderId, billcode, receivedHash });
      return new Response('Missing required fields', { status: 400, headers: corsHeaders(request) });
    }

    // 2. Validate signature
    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      console.error('❌ TOYYIBPAY_SECRET_KEY missing');
      return new Response('Server configuration error', { status: 500, headers: corsHeaders(request) });
    }

    const expectedHash = md5(`${secret}${status}${orderId}${refno}ok`);
    console.log(`🔑 Expected hash: ${expectedHash}, Received: ${receivedHash}`);

    if (expectedHash.toLowerCase() !== receivedHash.toLowerCase()) {
      console.error('❌ Signature mismatch');
      return new Response('Invalid signature', { status: 401, headers: corsHeaders(request) });
    }

    // 3. Idempotency – avoid double processing
    const db = env.DB;
    if (!db) {
      console.error('❌ DB not configured');
      return new Response('Server error', { status: 500, headers: corsHeaders(request) });
    }

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS webhook_log (
      id TEXT PRIMARY KEY,
      processed_at TEXT,
      type TEXT
    )`).run();

    const webhookId = request.headers.get('X-Webhook-Id') || refno || billcode || crypto.randomUUID();
    const existing = await db.prepare('SELECT id FROM webhook_log WHERE id = ?').bind(webhookId).first();
    if (existing) {
      console.log(`✅ Webhook ${webhookId} already processed, skipping`);
      return new Response('Already processed', { status: 200, headers: corsHeaders(request) });
    }

    // 4. Retrieve booking
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) { bookings = []; }

    const idx = bookings.findIndex(b => String(b.id) === orderId && String(b.toyyibpay_billcode || '') === billcode);
    if (idx === -1) {
      console.error(`❌ Booking not found for orderId: ${orderId}, billcode: ${billcode}`);
      return new Response('Booking not found', { status: 404, headers: corsHeaders(request) });
    }

    const booking = bookings[idx];
    console.log(`✅ Found booking: ${booking.id}, current status: ${booking.status}`);

    // 5. Check amount (optional, but recommended)
    const expectedAmount = Math.round(Number(booking.total) * 100);
    const callbackAmountCents = Math.round(Number(data.amount || 0) * 100);
    if (callbackAmountCents !== expectedAmount) {
      console.warn(`⚠️ Amount mismatch: expected ${expectedAmount}, got ${callbackAmountCents}`);
      // Still process but log warning
    }

    // 6. Update status based on payment status
    if (status === '1') {
      // Already paid? Skip if already completed
      if (booking.status && booking.status.toLowerCase().includes('paid')) {
        console.log(`ℹ️ Booking ${booking.id} already marked paid, skipping.`);
        return new Response('Already paid', { status: 200, headers: corsHeaders(request) });
      }

      bookings[idx] = {
        ...booking,
        status: 'Paid - Awaiting Check-in',
        paid_at: data.transaction_time || new Date().toISOString(),
        toyyibpay_refno: refno,
        toyyibpay_status: '1',
        toyyibpay_reason: String(data.reason || '')
      };
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      console.log(`✅ Booking ${booking.id} updated to PAID`);

      // Log action
      await logAction({
        db,
        action: 'payment_success_webhook',
        admin: 'toyyibpay',
        details: `Payment confirmed for ${booking.id}`,
        ip: ip,
        userId: booking.guestId,
        homestayId: booking.homestayId
      });
    } else if (status === '3') {
      bookings[idx] = {
        ...booking,
        status: 'Payment Failed',
        toyyibpay_refno: refno,
        toyyibpay_status: status,
        toyyibpay_reason: String(data.reason || '')
      };
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      console.log(`⚠️ Booking ${booking.id} marked as FAILED`);
    } else {
      console.log(`ℹ️ Unhandled status: ${status} for booking ${booking.id}`);
    }

    // 7. Record webhook idempotency
    await db.prepare('INSERT INTO webhook_log (id, processed_at, type) VALUES (?, ?, ?)')
      .bind(webhookId, new Date().toISOString(), 'payment').run();

    return new Response('OK', { status: 200, headers: corsHeaders(request) });
  } catch (e) {
    console.error('💥 Webhook error:', e.message, e.stack);
    return new Response('Server error: ' + e.message, { status: 500, headers: corsHeaders(request) });
  }
}

export async function onRequestGet({ request }) {
  return new Response('ToyyibPay webhook endpoint ready', { status: 200, headers: corsHeaders(request) });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

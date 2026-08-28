// /api/toyyibpay-webhook.js - with correct signature + logging
import { corsHeaders, enforceHttps, getClientIP, logAction, jsonResponse } from './_utils.js';

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
    for(let i=0;i<16;i++) M[i]=(bytes[off+4*i] | (bytes[off+4*i+1]<<8) | (bytes[off+4*i+2]<<16) | (bytes[off+4*i+3]<<24))>>>0;
    let A=a0, B=b0, C=c0, D=d0;
    for(let i=0;i<64;i++){
      let F, g;
      if(i<16){ F=(B&C)|((~B)&D); g=i; }
      else if(i<32){ F=(D&B)|((~D)&C); g=(5*i+1)%16; }
      else if(i<48){ F=B^C^D; g=(3*i+5)%16; }
      else { F=C^(B|(~D)); g=(7*i)%16; }
      F=(F+A+K[i]+M[g])>>>0;
      A=D; D=C; C=B; B=(B+rotl(F,S[i]))>>>0;
    }
    a0=(a0+A)>>>0; b0=(b0+B)>>>0; c0=(c0+C)>>>0; d0=(d0+D)>>>0;
  }
  const wordHex = n => Array.from({length:4}, (_,i) => ((n>>>(8*i))&255).toString(16).padStart(2,'0')).join('');
  return wordHex(a0) + wordHex(b0) + wordHex(c0) + wordHex(d0);
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  try {
    const type = request.headers.get('content-type') || '';
    let data = {};
    if (type.includes('application/json')) {
      data = await request.json();
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) data[k] = String(v);
    }

    // Log the entire payload for debugging
    console.log('📥 Webhook payload:', JSON.stringify(data, null, 2));

    const status = String(data.status || '');
    const orderId = String(data.order_id || '');
    const refno = String(data.refno || '');
    const billcode = String(data.billcode || '');
    const receivedHash = String(data.hash || '');

    if (!orderId || !billcode || !receivedHash) {
      console.warn('❌ Missing required fields:', { orderId, billcode, receivedHash });
      return new Response('invalid callback', { status: 400, headers: corsHeaders(request) });
    }

    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      console.error('❌ TOYYIBPAY_SECRET_KEY not set');
      return new Response('server not configured', { status: 500, headers: corsHeaders(request) });
    }

    // ---- CORRECT SIGNATURE: secret + billcode + status + order_id (+ optional "ok") ----
    // Try both common formats
    const hash1 = md5(`${secret}${billcode}${status}${orderId}`);
    const hash2 = md5(`${secret}${billcode}${status}${orderId}ok`);
    const hash3 = md5(`${secret}${status}${orderId}${refno}ok`); // legacy format (backward compat)

    console.log('🔑 Received hash:', receivedHash);
    console.log('🔑 Computed (billcode+status+order):', hash1);
    console.log('🔑 Computed (with "ok"):', hash2);
    console.log('🔑 Computed (legacy):', hash3);

    const isValid = (receivedHash.toLowerCase() === hash1.toLowerCase()) ||
                    (receivedHash.toLowerCase() === hash2.toLowerCase()) ||
                    (receivedHash.toLowerCase() === hash3.toLowerCase());

    if (!isValid) {
      console.error('❌ Invalid signature – rejecting');
      return new Response('invalid signature', { status: 401, headers: corsHeaders(request) });
    }

    console.log('✅ Signature verified');

    const db = env.DB;
    if (!db) return new Response('server error', { status: 500, headers: corsHeaders(request) });

    await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

    // ===== IDEMPOTENCY CHECK =====
    const webhookId = request.headers.get('X-Webhook-Id') || refno || billcode || crypto.randomUUID();
    await db.prepare(`CREATE TABLE IF NOT EXISTS webhook_log (
      id TEXT PRIMARY KEY,
      processed_at TEXT,
      type TEXT
    )`).run();

    const existing = await db.prepare('SELECT id FROM webhook_log WHERE id = ?').bind(webhookId).first();
    if (existing) {
      console.log(`✅ Webhook ${webhookId} already processed, skipping`);
      return new Response('Already processed', { status: 200, headers: corsHeaders(request) });
    }

    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try {
      if (r?.data) bookings = JSON.parse(r.data);
    } catch (_) {}

    const idx = bookings.findIndex(b =>
      String(b.id) === orderId && String(b.toyyibpay_billcode || '') === billcode
    );

    if (idx < 0) {
      console.warn(`❌ Booking not found for orderId=${orderId}, billcode=${billcode}`);
      return new Response('booking not found', { status: 404, headers: corsHeaders(request) });
    }

    const booking = bookings[idx];
    const expectedAmount = Math.round(Number(booking.total) * 100);
    const callbackAmountCents = Math.round(Number(data.amount || 0) * 100);

    if (callbackAmountCents !== expectedAmount) {
      console.warn(`❌ Amount mismatch: expected ${expectedAmount}, got ${callbackAmountCents}`);
      return new Response('amount mismatch', { status: 400, headers: corsHeaders(request) });
    }

    if (status === '1') {
      if (!/paid|completed/i.test(String(booking.status || ''))) {
        bookings[idx] = {
          ...booking,
          status: 'Paid - Awaiting Check-in',
          paid_at: data.transaction_time || new Date().toISOString(),
          toyyibpay_refno: refno,
          toyyibpay_status: '1',
          toyyibpay_reason: String(data.reason || '')
        };
        await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
          .bind('kd_bookings', JSON.stringify(bookings))
          .run();

        await logAction({
          db,
          action: 'payment_success',
          admin: 'toyyibpay',
          details: `Payment confirmed for ${orderId}`,
          ip: getClientIP(request),
          userId: booking.guestId,
          homestayId: booking.homestayId
        });

        console.log(`✅ Booking ${orderId} updated to Paid - Awaiting Check-in`);
      } else {
        console.log(`ℹ️ Booking ${orderId} already paid/completed`);
      }
    } else if (status === '3') {
      bookings[idx] = {
        ...booking,
        status: 'Payment Failed',
        toyyibpay_refno: refno,
        toyyibpay_status: status,
        toyyibpay_reason: String(data.reason || '')
      };
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
      console.log(`⚠️ Payment failed for ${orderId}`);
    } else {
      console.log(`ℹ️ Unknown status: ${status}`);
    }

    // Log webhook processing
    await db.prepare('INSERT INTO webhook_log (id, processed_at, type) VALUES (?, ?, ?)')
      .bind(webhookId, new Date().toISOString(), 'payment').run();

    return new Response('OK', { status: 200, headers: corsHeaders(request) });

  } catch (e) {
    console.error('❌ ToyyibPay webhook error:', e.message);
    return new Response('server error', { status: 500, headers: corsHeaders(request) });
  }
}

export async function onRequestGet() {
  return new Response('ToyyibPay webhook endpoint', { status: 200 });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

// /api/toyyibpay-webhook.js
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
  for(let off=0;off<bytes.length;off+=64){
    const M=new Uint32Array(16);
    for(let i=0;i<16;i++) M[i]=(bytes[off+4*i] | (bytes[off+4*i+1]<<8) | (bytes[off+4*i+2]<<16) | (bytes[off+4*i+3]<<24))>>>0;
    let A=a0,B=b0,C=c0,D=d0;
    for(let i=0;i<64;i++){
      let F,g;
      if(i<16){F=(B&C)|((~B)&D);g=i}
      else if(i<32){F=(D&B)|((~D)&C);g=(5*i+1)%16}
      else if(i<48){F=B^C^D;g=(3*i+5)%16}
      else {F=C^(B|(~D));g=(7*i)%16}
      F=(F+A+K[i]+M[g])>>>0;
      A=D;D=C;C=B;B=(B+rotl(F,S[i]))>>>0;
    }
    a0=(a0+A)>>>0;b0=(b0+B)>>>0;c0=(c0+C)>>>0;d0=(d0+D)>>>0;
  }
  const wordHex=n=>Array.from({length:4},(_,i)=>((n>>>(8*i))&255).toString(16).padStart(2,'0')).join('');
  return wordHex(a0)+wordHex(b0)+wordHex(c0)+wordHex(d0);
}

export async function onRequestPost({request,env}){
  const redirect=enforceHttps(request);if(redirect)return redirect;
  try{
    const type=request.headers.get('content-type')||'';
    let data={};
    if(type.includes('application/json')) data=await request.json();
    else {
      const form=await request.formData();
      for(const [k,v] of form.entries()) data[k]=String(v);
    }

    const status=String(data.status||'').trim();
    const orderId=String(data.order_id||'').trim();
    const refno=String(data.refno||'').trim();
    const billcode=String(data.billcode||'').trim();
    const receivedHash=String(data.hash||'').trim();
    const amountRaw=String(data.amount||'0').trim();

    // === Validate mandatory fields ===
    if(!orderId || !billcode || !receivedHash){
      console.error('Missing required fields:', {orderId, billcode, receivedHash});
      return new Response('Missing required fields', {status:400, headers:corsHeaders(request)});
    }

    // === Signature verification ===
    const secret=env.TOYYIBPAY_SECRET_KEY;
    if(!secret){
      console.error('TOYYIBPAY_SECRET_KEY not set');
      return new Response('Server configuration error', {status:500, headers:corsHeaders(request)});
    }
    const expected=md5(`${secret}${status}${orderId}${refno}ok`);
    if(expected.toLowerCase()!==receivedHash.toLowerCase()){
      console.error(`Hash mismatch: expected ${expected}, got ${receivedHash}`);
      return new Response('Invalid signature', {status:401, headers:corsHeaders(request)});
    }

    const db=env.DB;
    if(!db){
      console.error('DB not available');
      return new Response('DB error', {status:500, headers:corsHeaders(request)});
    }

    // === Retrieve bookings ===
    const r=await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings=[];
    try{if(r?.data) bookings=JSON.parse(r.data)}catch(_){}
    if(!bookings.length){
      console.error('No bookings found in store');
      return new Response('No bookings', {status:404, headers:corsHeaders(request)});
    }

    // === Find booking (match by order_id and billcode) ===
    const idx=bookings.findIndex(b => String(b.id)===orderId && String(b.toyyibpay_billcode||'')===billcode);
    if(idx<0){
      console.error(`Booking not found for order_id=${orderId}, billcode=${billcode}`);
      // Try to find by order_id only (fallback if billcode not stored yet)
      const fallbackIdx=bookings.findIndex(b => String(b.id)===orderId);
      if(fallbackIdx<0){
        return new Response('Booking not found', {status:404, headers:corsHeaders(request)});
      }
      // Use fallback, but ensure billcode matches after storing? We'll proceed cautiously.
      // We'll update the booking with the correct billcode if missing.
      bookings[fallbackIdx] = {...bookings[fallbackIdx], toyyibpay_billcode: billcode};
      const idx2 = fallbackIdx;
      // we continue processing with idx2
      // We'll re-find after update? Simpler: just process with fallbackIdx
      const booking=bookings[fallbackIdx];
      // Amount check
      const expectedAmount=Math.round(Number(booking.total)*100);
      const callbackAmountCents=Math.round(Number(amountRaw)); // FIXED: no *100
      if(callbackAmountCents!==expectedAmount){
        console.error(`Amount mismatch: expected ${expectedAmount}, got ${callbackAmountCents}`);
        return new Response('Amount mismatch', {status:400, headers:corsHeaders(request)});
      }

      // Update status
      if(status==='1'){
        bookings[fallbackIdx] = {
          ...booking,
          status: 'Paid - Awaiting Check-in',
          paid_at: data.transaction_time || new Date().toISOString(),
          toyyibpay_refno: refno,
          toyyibpay_status: '1',
          toyyibpay_reason: String(data.reason||'')
        };
      } else if(status==='3'){
        bookings[fallbackIdx] = {
          ...booking,
          status: 'Payment Failed',
          toyyibpay_refno: refno,
          toyyibpay_status: status,
          toyyibpay_reason: String(data.reason||'')
        };
      } else {
        // Other status (2=pending, etc.) – ignore or log
        return new Response('Status not actionable', {status:200, headers:corsHeaders(request)});
      }

      // Save
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();

      // Optional: log action
      await logAction({
        db,
        action: 'payment_webhook_fallback',
        admin: 'toyyibpay',
        details: `Payment status ${status} for ${orderId}`,
        ip: getClientIP(request),
        userId: booking.guestId,
        homestayId: booking.homestayId
      });

      return new Response('OK (fallback)', {status:200, headers:corsHeaders(request)});
    }

    // === Normal path: booking found with both id and billcode ===
    const booking=bookings[idx];
    const expectedAmount=Math.round(Number(booking.total)*100);
    const callbackAmountCents=Math.round(Number(amountRaw)); // FIXED: no *100
    if(callbackAmountCents!==expectedAmount){
      console.error(`Amount mismatch: expected ${expectedAmount}, got ${callbackAmountCents}`);
      return new Response('Amount mismatch', {status:400, headers:corsHeaders(request)});
    }

    // === Idempotency: skip if already processed (optional, can comment out) ===
    // To avoid blocking during debugging, we'll skip this check temporarily.
    // Uncomment the following block to re-enable.
    /*
    const webhookId = request.headers.get('X-Webhook-Id') || refno || billcode || crypto.randomUUID();
    await db.prepare(`CREATE TABLE IF NOT EXISTS webhook_log (
      id TEXT PRIMARY KEY,
      processed_at TEXT,
      type TEXT
    )`).run();
    const existing = await db.prepare('SELECT id FROM webhook_log WHERE id = ?').bind(webhookId).first();
    if (existing) {
      console.log(`Webhook ${webhookId} already processed, skipping`);
      return new Response('Already processed', { status: 200, headers: corsHeaders(request) });
    }
    */

    // === Process status ===
    if(status==='1'){
      // Only update if not already paid/completed
      const currentStatus = String(booking.status||'');
      if(!/paid|completed/i.test(currentStatus)){
        bookings[idx] = {
          ...booking,
          status: 'Paid - Awaiting Check-in',
          paid_at: data.transaction_time || new Date().toISOString(),
          toyyibpay_refno: refno,
          toyyibpay_status: '1',
          toyyibpay_reason: String(data.reason||'')
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
        return new Response('OK', {status:200, headers:corsHeaders(request)});
      } else {
        // Already paid, just acknowledge
        return new Response('Already paid', {status:200, headers:corsHeaders(request)});
      }
    } else if(status==='3'){
      bookings[idx] = {
        ...booking,
        status: 'Payment Failed',
        toyyibpay_refno: refno,
        toyyibpay_status: status,
        toyyibpay_reason: String(data.reason||'')
      };
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
      await logAction({
        db,
        action: 'payment_failed',
        admin: 'toyyibpay',
        details: `Payment failed for ${orderId}`,
        ip: getClientIP(request),
        userId: booking.guestId,
        homestayId: booking.homestayId
      });
      return new Response('OK', {status:200, headers:corsHeaders(request)});
    } else {
      // status 2 (pending) or other – ignore
      return new Response('Status ignored', {status:200, headers:corsHeaders(request)});
    }

  } catch(e){
    console.error('Webhook error:', e.message, e.stack);
    return new Response('Server error', {status:500, headers:corsHeaders(request)});
  }
}

export async function onRequestGet({request}){
  return new Response('ToyyibPay webhook endpoint ready', {status:200, headers:corsHeaders(request)});
}

export async function onRequestOptions({request}){
  return new Response(null, {headers: corsHeaders(request)});
}

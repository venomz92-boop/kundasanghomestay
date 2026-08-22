// /api/toyyibpay-webhook.js - SECURE: verify secret key, reject if not set

export async function onRequestPost({ request, env }) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    const customHeader = request.headers.get('X-Toyyibpay-Secret') || '';
    const expectedToken = env.TOYYIBPAY_SECRET_KEY || '';
    
    const isAuthorized = 
      authHeader === 'Bearer ' + expectedToken ||
      authHeader === expectedToken ||
      customHeader === expectedToken ||
      customHeader === 'Bearer ' + expectedToken;
    
    // CRITICAL FIX: In production, reject if secret not set or invalid
    if (!expectedToken) {
      console.error('🔐 TOYYIBPAY_SECRET_KEY not set – webhook UNSECURED! Rejecting.');
      return new Response('Unauthorized - Secret key not configured', { status: 401, headers: cors() });
    }
    
    if (!isAuthorized) {
      console.warn('🔐 Webhook unauthorized: missing or invalid secret');
      return new Response('Unauthorized', { status: 401, headers: cors() });
    }

    // --- Parse webhook data ---
    const formData = await request.formData();
    const refNo = formData.get('refno');
    const status = formData.get('status');
    const billcode = formData.get('billcode');
    const orderId = formData.get('order_id');
    const amount = formData.get('amount');
    const signature = formData.get('signature');

    console.log("📡 ToyyibPay webhook received:", { refNo, status, billcode, amount, hasSignature: !!signature });

    if (String(status) !== "1") {
      console.log(`⚠️ Payment not successful - status: ${status}`);
      return new Response(`Not success - status ${status}`, { status: 200, headers: cors() });
    }

    if (!refNo) {
      console.error('❌ Missing refno in webhook');
      return new Response('Missing refno', { status: 400, headers: cors() });
    }

    const db = env.DB;
    if (!db) {
      console.error('❌ No database configured');
      return new Response('No DB', { status: 500, headers: cors() });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    
    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res) { try { bookings = JSON.parse(res.data); } catch(e) { console.error('Failed to parse bookings:', e); } }

    const idx = bookings.findIndex(b => String(b.id) === String(refNo));
    
    if (idx !== -1) {
      if (bookings[idx].status && 
          bookings[idx].status.toLowerCase().includes("paid") && 
          bookings[idx].paid_at) {
        console.log(`✅ Booking ${refNo} already processed, skipping duplicate`);
        return new Response("Already processed", { status: 200, headers: cors() });
      }
      
      console.log(`✅ Updating booking ${refNo} to PAID`);
      bookings[idx].status = "Paid - Awaiting Check-in";
      bookings[idx].toyyibpay_billcode = billcode;
      bookings[idx].toyyibpay_order_id = orderId;
      bookings[idx].paid_at = new Date().toISOString();
      bookings[idx].toyyibpay_amount = amount;
      bookings[idx].statusUpdated = new Date().toISOString();
      bookings[idx].webhook_received_at = new Date().toISOString();
      
    } else {
      console.warn(`⚠️ Booking ${refNo} not found, creating from webhook data`);
      const guestEmail = formData.get('billEmail') || formData.get('email') || 'guest@unknown.com';
      const guestName = formData.get('billTo') || formData.get('name') || 'Guest';
      const guestPhone = formData.get('billPhone') || formData.get('phone') || '';
      
      const newBooking = {
        id: refNo,
        status: "Paid - Awaiting Check-in",
        toyyibpay_billcode: billcode,
        toyyibpay_order_id: orderId,
        toyyibpay_amount: amount,
        paid_at: new Date().toISOString(),
        statusUpdated: new Date().toISOString(),
        webhook_received_at: new Date().toISOString(),
        guestEmail: guestEmail,
        guestName: guestName,
        guestPhone: guestPhone,
        homestay: 'Unknown (webhook)',
        needsAdminReview: true
      };
      bookings.push(newBooking);
      console.log(`✅ Created new booking ${refNo} from webhook data`);
    }

    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();

    // --- Block availability (rest unchanged) ---
    try {
      const availRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
      let availability = {};
      if (availRes) { try { availability = JSON.parse(availRes.data); } catch(e){} }
      
      const updatedBooking = bookings[idx !== -1 ? idx : bookings.length - 1];
      if (updatedBooking && updatedBooking.homestayId && updatedBooking.checkin && updatedBooking.checkout) {
        if (!availability[updatedBooking.homestayId]) availability[updatedBooking.homestayId] = [];
        const dates = getDatesInRange(updatedBooking.checkin, updatedBooking.checkout);
        dates.forEach(d => { 
          if (!availability[updatedBooking.homestayId].includes(d)) {
            availability[updatedBooking.homestayId].push(d); 
          }
        });
        availability[updatedBooking.homestayId] = [...new Set(availability[updatedBooking.homestayId])].sort();
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(availability)).run();
        console.log(`📅 Blocked ${dates.length} dates for homestay ${updatedBooking.homestayId}`);
      }
    } catch(e) { console.error('❌ Availability error:', e.message); }

    console.log(`✅ Webhook processed successfully for ${refNo}`);
    return new Response("OK", { status: 200, headers: cors() });
    
  } catch (e) {
    console.error('❌ Webhook error:', e.message, e.stack);
    return new Response("Error: "+e.message, { status: 500, headers: cors() });
  }
}

export async function onRequestGet(){ 
  return new Response("ToyyibPay webhook ready", { status: 200, headers: cors() }); 
}

function getDatesInRange(checkin, checkout){
  if(!checkin||!checkout) return [];
  const dates=[]; 
  const start=new Date(checkin+"T00:00:00"); 
  const end=new Date(checkout+"T00:00:00");
  if(isNaN(start)||isNaN(end)||start>=end) return [];
  const cur=new Date(start);
  while(cur<end){ 
    const y=cur.getFullYear(); 
    const m=String(cur.getMonth()+1).padStart(2,'0'); 
    const d=String(cur.getDate()).padStart(2,'0'); 
    dates.push(`${y}-${m}-${d}`); 
    cur.setDate(cur.getDate()+1); 
  }
  return dates;
}

function cors(){ 
  return { 
    "Access-Control-Allow-Origin": "*", 
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", 
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Toyyibpay-Secret" 
  }; 
}

export async function onRequestOptions(){ 
  return new Response(null, { headers: cors() }); 
}

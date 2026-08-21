// /api/toyyibpay-webhook.js
// ToyyibPay callback - marks booking as Paid, blocks dates, ready for owner payout on check-in

export async function onRequestPost({ request, env }) {
  try {
    const formData = await request.formData();
    const refNo = formData.get('refno'); // bookingId = billExternalReferenceNo
    const status = formData.get('status'); // 1 = success, 2 = pending, 3 = fail
    const reason = formData.get('reason');
    const billcode = formData.get('billcode');
    const orderId = formData.get('order_id');
    const amount = formData.get('amount');

    console.log("ToyyibPay webhook", { refNo, status, billcode, amount });

    // Status 1 = success
    if (String(status) !== "1") {
      return new Response("Not success - status "+status, { status: 200, headers: cors() });
    }

    const db = env.DB;
    if (!db) return new Response("No DB", { status: 500, headers: cors() });

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res) { try { bookings = JSON.parse(res.data); } catch(e) {} }

    const idx = bookings.findIndex(b => String(b.id) === String(refNo));
    if (idx !== -1) {
      if (bookings[idx].status && bookings[idx].status.toLowerCase().includes("paid") && bookings[idx].paid_at) {
        console.log("Already paid", refNo);
      } else {
        bookings[idx].status = "Paid - Awaiting Check-in";
        bookings[idx].toyyibpay_billcode = billcode;
        bookings[idx].toyyibpay_order_id = orderId;
        bookings[idx].paid_at = new Date().toISOString();
        bookings[idx].toyyibpay_amount = amount;
        bookings[idx].statusUpdated = new Date().toISOString();
      }
    } else {
      console.log("Booking not found for webhook", refNo);
    }

    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();

    // Block availability now (was pending before)
    try {
      const availRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
      let availability = {};
      if (availRes) { try { availability = JSON.parse(availRes.data); } catch(e){} }
      if (idx !== -1) {
        const b = bookings[idx];
        if (b && b.homestayId && b.checkin && b.checkout) {
          if (!availability[b.homestayId]) availability[b.homestayId] = [];
          const dates = getDatesInRange(b.checkin, b.checkout);
          dates.forEach(d => { if (!availability[b.homestayId].includes(d)) availability[b.homestayId].push(d); });
          availability[b.homestayId] = [...new Set(availability[b.homestayId])].sort();
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(availability)).run();
        }
      }
    } catch(e) { console.log("Avail error", e.message); }

    return new Response("OK", { status: 200, headers: cors() });
  } catch (e) {
    return new Response("Error: "+e.message, { status: 500, headers: cors() });
  }
}

export async function onRequestGet(){ return new Response("ToyyibPay webhook ready", { status: 200, headers: cors() }); }

function getDatesInRange(checkin, checkout){
  if(!checkin||!checkout) return [];
  const dates=[]; const start=new Date(checkin+"T00:00:00"); const end=new Date(checkout+"T00:00:00");
  if(isNaN(start)||isNaN(end)||start>=end) return [];
  const cur=new Date(start);
  while(cur<end){ const y=cur.getFullYear(); const m=String(cur.getMonth()+1).padStart(2,'0'); const d=String(cur.getDate()).padStart(2,'0'); dates.push(`${y}-${m}-${d}`); cur.setDate(cur.getDate()+1); }
  return dates;
}
function cors(){ return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }
export async function onRequestOptions(){ return new Response(null, { headers: cors() }); }

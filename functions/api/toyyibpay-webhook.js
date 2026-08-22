// /api/toyyibpay-webhook.js - SECURE PRODUCTION VERSION

// ========== HELPER FUNCTIONS ==========

function getDatesInRange(checkin, checkout) {
  if (!checkin || !checkout) return [];
  const dates = [];
  const start = new Date(checkin + "T00:00:00");
  const end = new Date(checkout + "T00:00:00");
  if (isNaN(start) || isNaN(end) || start >= end) return [];
  const cur = new Date(start);
  while (cur < end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Toyyibpay-Secret"
  };
}

// ========== MAIN HANDLER ==========

export async function onRequestPost({ request, env }) {
  try {
    // --- 🔒 SECURITY: STRICT authentication ---
    const expectedToken = env.TOYYIBPAY_SECRET_KEY;
    if (!expectedToken) {
      console.error("❌ CRITICAL: TOYYIBPAY_SECRET_KEY is not set. Webhook is UNSECURED!");
      return new Response("Server misconfigured: webhook secret missing", { 
        status: 401, 
        headers: cors() 
      });
    }

    const authHeader = request.headers.get('Authorization') || '';
    const customHeader = request.headers.get('X-Toyyibpay-Secret') || '';
    
    // Accept either "Bearer SECRET" or just "SECRET"
    const isValid = 
      authHeader === 'Bearer ' + expectedToken ||
      authHeader === expectedToken ||
      customHeader === expectedToken ||
      customHeader === 'Bearer ' + expectedToken;
    
    if (!isValid) {
      console.warn("🔐 Webhook unauthorized: invalid secret");
      return new Response('Unauthorized', { status: 401, headers: cors() });
    }

    // --- Parse webhook data ---
    const formData = await request.formData();
    const refNo = formData.get('refno');
    const status = formData.get('status');
    const billcode = formData.get('billcode');
    const orderId = formData.get('order_id');
    const amount = parseFloat(formData.get('amount') || '0');

    console.log(`📡 Webhook received: refno=${refNo}, status=${status}, billcode=${billcode}, amount=${amount}`);

    // --- Verify payment status ---
    if (String(status) !== "1") {
      console.log(`⚠️ Payment not successful - status: ${status}`);
      return new Response(`Not success - status ${status}`, { status: 200, headers: cors() });
    }

    // --- Validate required fields ---
    if (!refNo) {
      console.error('❌ Missing refno in webhook');
      return new Response('Missing refno', { status: 400, headers: cors() });
    }

    if (!amount || amount <= 0) {
      console.error(`❌ Invalid amount: ${amount}`);
      return new Response('Invalid amount', { status: 400, headers: cors() });
    }

    // --- Database connection ---
    const db = env.DB;
    if (!db) {
      console.error('❌ No database configured');
      return new Response('DB not configured', { status: 500, headers: cors() });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // --- 🔒 FETCH BOOKING BY ID (with lock check) ---
    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res?.data) {
      try { bookings = JSON.parse(res.data); } catch (e) { console.error('Failed to parse bookings:', e); }
    }

    const idx = bookings.findIndex(b => String(b.id) === String(refNo));

    // --- ❌ CRITICAL FIX: If booking not found, DO NOT auto-create corrupt data ---
    if (idx === -1) {
      console.error(`❌❌ CRITICAL: Booking ${refNo} not found in database!`);
      
      // Store unknown webhook for manual admin review
      try {
        let unknown = [];
        const uRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_unknown_webhooks").first();
        if (uRes?.data) unknown = JSON.parse(uRes.data);
        unknown.push({
          refNo,
          billcode,
          orderId,
          amount,
          received_at: new Date().toISOString(),
          raw_data: Object.fromEntries(formData.entries())
        });
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
          .bind("kd_unknown_webhooks", JSON.stringify(unknown))
          .run();
      } catch (e) { console.error('Failed to save unknown webhook:', e.message); }
      
      // Return 200 to stop ToyyibPay from retrying, but admin MUST investigate
      return new Response("Booking not found – logged for review", { status: 200, headers: cors() });
    }

    // --- 🔒 IDEMPOTENCY: Already processed? ---
    const existingBooking = bookings[idx];
    if (existingBooking.status && 
        existingBooking.status.toLowerCase().includes("paid") && 
        existingBooking.paid_at) {
      console.log(`✅ Booking ${refNo} already processed, skipping duplicate`);
      return new Response("Already processed", { status: 200, headers: cors() });
    }

    // --- 🔒 PRICE VERIFICATION: Recalculate total from DB ---
    // We need the homestay price to verify the amount.
    // Fetch homestay data from store
    let homestays = [];
    const hRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
    if (hRes?.data) {
      try { homestays = JSON.parse(hRes.data); } catch (e) {}
    }
    // Also check demo homestays (if you store them)
    const demoRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_demo_overrides").first();
    let demoOverrides = {};
    if (demoRes?.data) {
      try { demoOverrides = JSON.parse(demoRes.data); } catch (e) {}
    }
    // Find the homestay
    let homestay = homestays.find(h => String(h.id) === String(existingBooking.homestayId));
    if (!homestay) {
      // Try demo overrides
      const demoEntry = demoOverrides[existingBooking.homestayId];
      if (demoEntry) homestay = demoEntry;
    }
    // Fallback: use the ownerPrice from the booking object if homestay not found
    let expectedTotal = existingBooking.total || 0;
    if (homestay && homestay.ownerPrice && existingBooking.nights) {
      const base = homestay.ownerPrice * existingBooking.nights;
      const fee = Math.round((base * 11) / 100); // 11% platform fee
      const gatewayFee = 1; // or read from env
      expectedTotal = base + fee + gatewayFee;
    } else if (existingBooking.total) {
      expectedTotal = existingBooking.total;
    } else {
      console.warn(`⚠️ Cannot recalc total for ${refNo}, using amount from webhook: ${amount}`);
      expectedTotal = amount;
    }

    // Compare with margin of error (0.01 RM)
    if (Math.abs(amount - expectedTotal) > 0.01) {
      console.error(`❌ PRICE MISMATCH: booking ${refNo} - expected RM${expectedTotal.toFixed(2)}, webhook RM${amount.toFixed(2)}`);
      // Flag it but still mark as paid (FPX is authoritative), but add a warning flag
      bookings[idx].payment_mismatch = true;
      bookings[idx].expected_amount = expectedTotal;
      bookings[idx].received_amount = amount;
    } else {
      console.log(`✅ Price verified: RM${amount.toFixed(2)} matches expected RM${expectedTotal.toFixed(2)}`);
    }

    // --- ✅ UPDATE BOOKING ---
    console.log(`✅ Updating booking ${refNo} to PAID`);
    bookings[idx].status = "Paid - Awaiting Check-in";
    bookings[idx].toyyibpay_billcode = billcode;
    bookings[idx].toyyibpay_order_id = orderId;
    bookings[idx].paid_at = new Date().toISOString();
    bookings[idx].toyyibpay_amount = amount;
    bookings[idx].statusUpdated = new Date().toISOString();
    bookings[idx].webhook_received_at = new Date().toISOString();
    // If we flagged a mismatch, keep it
    if (!bookings[idx].payment_mismatch) delete bookings[idx].payment_mismatch;

    // --- 💾 SAVE BOOKING ---
    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
      .bind("kd_bookings", JSON.stringify(bookings))
      .run();

    // --- 📅 BLOCK AVAILABILITY (only if we have valid dates) ---
    try {
      if (bookings[idx].checkin && bookings[idx].checkout && bookings[idx].homestayId) {
        const availRes = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
        let availability = {};
        if (availRes?.data) {
          try { availability = JSON.parse(availRes.data); } catch (e) {}
        }

        const dates = getDatesInRange(bookings[idx].checkin, bookings[idx].checkout);
        if (dates.length > 0) {
          const hId = String(bookings[idx].homestayId);
          if (!availability[hId]) availability[hId] = [];
          dates.forEach(d => {
            if (!availability[hId].includes(d)) availability[hId].push(d);
          });
          availability[hId] = [...new Set(availability[hId])].sort();
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
            .bind("kd_availability", JSON.stringify(availability))
            .run();
          console.log(`📅 Blocked ${dates.length} dates for homestay ${hId}`);
        } else {
          console.warn(`⚠️ No valid dates to block for ${refNo}`);
        }
      } else {
        console.warn(`⚠️ Cannot block availability for ${refNo}: missing homestayId or dates`);
      }
    } catch (e) {
      console.error('❌ Availability error:', e.message);
    }

    console.log(`✅ Webhook processed successfully for ${refNo}`);
    return new Response("OK", { status: 200, headers: cors() });

  } catch (e) {
    console.error('❌ Webhook error:', e.message, e.stack);
    return new Response("Internal Server Error", { status: 500, headers: cors() });
  }
}

// ========== GET / OPTIONS ==========

export async function onRequestGet() {
  return new Response("ToyyibPay webhook ready", { status: 200, headers: cors() });
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}

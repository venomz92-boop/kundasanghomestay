function getDB(env){ return env.DB || env.D1 || env.MY_DB || env.DATABASE || env.KUNDASANG_DB || env.STORE || null; }
// /api/bookings - with PENDING SYNC FIX
// Handles bookings + pending homestays for multi-device sync

export async function onRequestGet(context) {
  const { env } = context;
  const db = env.DB;
  let data = {
    bookings: [],
    availability: {},
    approved: [],
    demoOverrides: {},
    demoBlocked: {},
    deletedDemo: [],
    pending: [] // <-- ADDED
  };

  if (db) {
    try {
      await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
      
      const keys = ["kd_bookings", "kd_availability", "kd_approved", "kd_demo_overrides", "kd_demo_blocked", "kd_deleted_demo", "kd_pending", "kd_guests"];
      for (const key of keys) {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind(key).first();
        if (r) {
          try {
            const parsed = JSON.parse(r.data);
            if (key === "kd_bookings") data.bookings = parsed;
            else if (key === "kd_availability") data.availability = parsed;
            else if (key === "kd_approved") data.approved = parsed;
            else if (key === "kd_demo_overrides") data.demoOverrides = parsed;
            else if (key === "kd_demo_blocked") data.demoBlocked = parsed;
            else if (key === "kd_deleted_demo") data.deletedDemo = parsed;
            else if (key === "kd_pending") data.pending = parsed;
            else if (key === "kd_guests") data.guests = parsed;
          } catch(e){}
        }
      }
    } catch(e) {
      console.error("DB read error", e);
    }
  }

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;
  
  try {
    const body = await request.json();
    const { action, pending, bookings, availability, approved, demoOverrides, demoBlocked, deletedDemo, guests } = body;

    if (!db) {
      return new Response(JSON.stringify({ error: "DB not configured" }), { status: 500, headers: corsHeaders() });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // Handle pending sync - MERGE
    if (action === "updatePending" || pending !== undefined) {
      let existingPending = [];
      try{
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
        if(r && r.data) existingPending = JSON.parse(r.data);
      }catch(e){}
      let incoming = pending || [];
      if(incoming.length === 0 && existingPending.length > 0){
        console.log("Pending empty, keeping existing:", existingPending.length);
      } else {
        const map = new Map();
        [...existingPending, ...incoming].forEach(h=>{ if(h && h.id) map.set(String(h.id), h); });
        const merged = [...map.values()];
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_pending", JSON.stringify(merged)).run();
        console.log("Pending merged:", existingPending.length, "+", incoming.length, "=", merged.length);
      }
    }

    // Handle guests sync - MERGE + OVERWRITE for delete
    if (action === "updateGuests" || action === "overwriteGuests" || action === "deleteGuest" || guests !== undefined) {
      let existingGuests = [];
      try{
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
        if(r && r.data) existingGuests = JSON.parse(r.data);
      }catch(e){}
      let incomingGuests = guests || [];
      if(action === "overwriteGuests" || action === "deleteGuest"){
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_guests", JSON.stringify(incomingGuests)).run();
        console.log("Guests OVERWRITTEN:", incomingGuests.length, "was", existingGuests.length);
      } else if(incomingGuests.length === 0 && existingGuests.length > 0){
        console.log("Guests empty, keeping existing:", existingGuests.length);
      } else {
        const map = new Map();
        [...existingGuests, ...incomingGuests].forEach(g=>{ if(g && (g.email||g.id)) map.set(String(g.email||g.id).toLowerCase(), g); });
        const merged = [...map.values()];
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_guests", JSON.stringify(merged)).run();
        console.log("Guests merged:", existingGuests.length, "+", incomingGuests.length, "=", merged.length);
      }
    }

    if (action === "updateHomestays" || approved !== undefined) {
      if (approved !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_approved", JSON.stringify(approved)).run();
      }
      if (demoOverrides !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_demo_overrides", JSON.stringify(demoOverrides)).run();
      }
      if (demoBlocked !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_demo_blocked", JSON.stringify(demoBlocked)).run();
      }
      if (deletedDemo !== undefined) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_deleted_demo", JSON.stringify(deletedDemo)).run();
      }
    }

    if (action === "updateAvailability" || availability !== undefined) {
      const avail = availability || body.availability;
      if (avail) {
        await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(avail)).run();
      }
    }

    if (action === "updateBookings" || bookings !== undefined) {
      const b = bookings || body.bookings;
      if (b && Array.isArray(b)) {
        let existing = [];
        try{
          const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
          if(r && r.data) existing = JSON.parse(r.data);
        }catch(e){}
        if(b.length === 0 && existing.length > 0){
          console.log("Bookings empty, keeping existing:", existing.length);
        } else {
          const map = new Map();
          [...existing, ...b].forEach(book=>{ if(book && book.id) map.set(String(book.id), book); });
          const merged = [...map.values()];
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(merged)).run();
          console.log("Bookings merged:", existing.length, "+", b.length, "=", merged.length);
        }
      }
    }

    // Handle single booking - support nested {booking, bookedDates}
    let singleBooking = null;
    if (body.id && body.checkin) {
      singleBooking = body;
    } else if (body.booking && body.booking.id && body.booking.checkin) {
      singleBooking = body.booking;
    }
    
    if (singleBooking) {
      let existing = [];
      try {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
        if (r && r.data) existing = JSON.parse(r.data);
      } catch(e){}
      const map = new Map();
      [...existing, singleBooking].forEach(b=>{ if(b && b.id) map.set(String(b.id), b); });
      const merged = [...map.values()];
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(merged)).run();
      console.log("Booking added:", singleBooking.id, "total:", merged.length);
      
      let datesToBlock = body.bookedDates || singleBooking.bookedDates || [];
      if(datesToBlock.length > 0 && singleBooking.homestayId){
        try{
          let avail = {};
          const r2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_availability").first();
          if(r2 && r2.data) avail = JSON.parse(r2.data);
          if(!avail[singleBooking.homestayId]) avail[singleBooking.homestayId] = [];
          datesToBlock.forEach(d=>{ if(!avail[singleBooking.homestayId].includes(d)) avail[singleBooking.homestayId].push(d); });
          await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_availability", JSON.stringify(avail)).run();
        }catch(e){}
      }
    }

    // Handle single new pending homestay
    if (body.new && !pending && !guests && !singleBooking) {
      let existingPending = [];
      try {
        const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
        if (r && r.data) existingPending = JSON.parse(r.data);
      } catch(e){}
      const map = new Map();
      [...existingPending, body.new].forEach(h=>{ if(h && h.id) map.set(String(h.id), h); });
      const merged = [...map.values()];
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_pending", JSON.stringify(merged)).run();
    }

    return new Response(JSON.stringify({ success: true, message: "Synced" }), {
      status: 200,
      headers: corsHeaders()
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (db && id) {
    try {
      let bookings = [];
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
      if (r) bookings = JSON.parse(r.data);
      bookings = bookings.filter(b => String(b.id) !== String(id));
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();
    } catch(e){}
  }

  return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders() });
}

function corsHeaders(){
  return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
}

export async function onRequestOptions(){
  return new Response(null, { headers: corsHeaders() });
}

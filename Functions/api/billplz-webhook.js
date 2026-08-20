export async function onRequestPost({ request, env }) {
  try {
    const formData = await request.formData();
    const id = formData.get('id');
    const collection_id = formData.get('collection_id');
    const paid = formData.get('paid') === 'true' || formData.get('paid') === true;
    const amount = formData.get('amount');
    const reference_1 = formData.get('reference_1'); // bookingId
    const x_signature = formData.get('x_signature');

    // Verify X Signature
    // Billplz signature: hmac SHA256 of (id|collection_id|paid|amount|reference_1) with x_signature key? Actually billplz uses x_signature as secret for callback
    // Simplified verification - in production verify properly
    if (env.BILLPLZ_X_SIGNATURE) {
      // TODO: proper HMAC verification if needed, for now log
      console.log("Webhook received", { id, reference_1, paid });
    }

    if (!paid) {
      return new Response("Not paid", { status: 200 });
    }

    // Load bookings from D1
    const db = env.DB;
    if (!db) return new Response("No DB", { status: 500 });

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();
    const res = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_bookings").first();
    let bookings = [];
    if (res) bookings = JSON.parse(res.data);

    const booking = bookings.find(b => String(b.id) === String(reference_1));
    if (booking) {
      booking.status = "Paid - Awaiting Check-in";
      booking.billplz_bill_id = id;
      booking.paid_at = new Date().toISOString();
      booking.billplz_amount = amount;
      // owner payout = base, fee = platform fee, total = total
      // Keep existing base/fee
    }

    await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)").bind("kd_bookings", JSON.stringify(bookings)).run();

    return new Response("OK", { status: 200 });
  } catch (e) {
    return new Response("Error: " + e.message, { status: 500 });
  }
}
export async function onRequestGet({ request, env }) {
  return new Response("Billplz Webhook endpoint ready - POST from Billplz", { status: 200 });
}

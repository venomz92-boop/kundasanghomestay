// /api/verify-payment.js – CHIP + email on success
import { corsHeaders } from './_utils.js';

async function sendCheckinEmail(booking, env) {
  const html = `
    <h2>Hello ${booking.guestName || 'Guest'},</h2>
    <p>Your booking <strong>${booking.id}</strong> at <strong>${booking.homestay}</strong> is confirmed.</p>
    <p><strong>Check‑in Code:</strong> <span style="font-size:24px;font-weight:bold;color:#0F382E;">${booking.checkinCode}</span></p>
    <p>Please present this code to the host upon arrival.</p>
  `;
  try {
    if (env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: booking.guestEmail,
          subject: 'Your Check‑in Code – Payment Confirmed',
          html
        })
      });
    } else if (env.SENDGRID_API_KEY) {
      await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: booking.guestEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Your Check‑in Code – Payment Confirmed',
          content: [{ type: 'text/html', value: html }]
        })
      });
    }
  } catch (e) { console.error('Email send error:', e.message); }
}

export async function onRequestPost({ request, env }) {
  try {
    const { bookingId } = await request.json();
    if (!bookingId) {
      return new Response(JSON.stringify({ error: 'Missing bookingId' }), {
        status: 400,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: 'DB not configured' }), {
        status: 500,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch (_) {}
    const idx = bookings.findIndex(b => String(b.id) === bookingId);
    if (idx === -1) {
      return new Response(JSON.stringify({ error: 'Booking not found' }), {
        status: 404,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const booking = bookings[idx];
    const status = booking.status || 'Pending Payment';

    // Already paid?
    if (['Paid - Awaiting Check-in', 'Completed'].includes(status)) {
      return new Response(JSON.stringify({ success: true, booking, paid: true }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    // ---- CHIP path ----
    if (booking.chip_purchase_id) {
      const chipSecret = env.CHIP_SECRET_KEY;
      if (!chipSecret) {
        return new Response(JSON.stringify({
          success: false,
          message: 'CHIP secret not configured',
          retry: true,
          booking,
          paymentStatus: 'pending'
        }), {
          status: 200,
          headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
        });
      }

      try {
        const resp = await fetch(`https://gate.chip-in.asia/api/v1/purchases/${booking.chip_purchase_id}/`, {
          headers: { 'Authorization': `Bearer ${chipSecret}` }
        });
        if (!resp.ok) {
          return new Response(JSON.stringify({
            success: false,
            message: 'Could not fetch purchase status',
            retry: true,
            booking,
            paymentStatus: 'pending'
          }), {
            status: 200,
            headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
          });
        }
        const purchase = await resp.json();
        const purchaseStatus = purchase.status;
        if (purchaseStatus === 'completed' || purchaseStatus === 'paid') {
          if (!booking.checkinCode) {
            booking.checkinCode = Math.floor(100000 + Math.random() * 900000).toString();
          }
          bookings[idx] = {
            ...booking,
            status: 'Paid - Awaiting Check-in',
            paid_at: new Date().toISOString(),
            chip_status: 'paid'
          };
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();

          // ✅ Send email immediately (fallback)
          await sendCheckinEmail(bookings[idx], env);

          return new Response(JSON.stringify({ success: true, booking: bookings[idx], paid: true }), {
            status: 200,
            headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
          });
        } else if (purchaseStatus === 'cancelled' || purchaseStatus === 'expired' || purchaseStatus === 'failed') {
          bookings[idx].status = 'Payment Failed';
          await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
            .bind('kd_bookings', JSON.stringify(bookings))
            .run();
          return new Response(JSON.stringify({
            success: false,
            message: 'Payment failed or expired.',
            retry: true,
            booking: bookings[idx],
            paymentStatus: 'failed'
          }), {
            status: 200,
            headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
          });
        } else {
          // pending
          return new Response(JSON.stringify({
            success: false,
            message: 'Payment not yet confirmed.',
            retry: true,
            booking,
            paymentStatus: 'pending'
          }), {
            status: 200,
            headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
          });
        }
      } catch (e) {
        console.error('CHIP check error:', e.message);
        return new Response(JSON.stringify({
          success: false,
          message: 'Error checking CHIP status: ' + e.message,
          retry: true,
          booking,
          paymentStatus: 'pending'
        }), {
          status: 200,
          headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
        });
      }
    }

    // ---- ToyyibPay fallback (if billcode exists) ----
    if (booking.toyyibpay_billcode) {
      // Keep your existing ToyyibPay logic here (or skip)
      return new Response(JSON.stringify({
        success: false,
        message: 'Booking uses ToyyibPay. Please use the Check Payment button if needed.',
        retry: true,
        booking,
        paymentStatus: 'pending'
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      success: false,
      message: 'No payment provider found for this booking.',
      retry: true,
      booking,
      paymentStatus: 'pending'
    }), {
      status: 200,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('❌ verify-payment error:', e.message);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

// /api/verify-payment.js – CHIP + email on success
import { corsHeaders } from './_utils.js';

// ===== EMAIL FUNCTION with Professional Receipt Layout =====
async function sendCheckinEmail(booking, env) {
  // Generate receipt number: RCP-YYYYMMDD-XXXX (last 6 of booking ID)
  const receiptNo = `RCP-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${booking.id.slice(-6)}`;

  // Prepare price breakdown
  const base = Number(booking.base || 0);
  const fee = Number(booking.fee || 0);
  const gatewayFee = Number(booking.gatewayFee || 0);
  const total = Number(booking.total || 0);

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f5f0; padding: 20px; border-radius: 16px;">
      <div style="background: #ffffff; padding: 30px; border-radius: 16px; border: 1px solid #e5e7eb;">
        <!-- Header -->
        <div style="text-align: center; border-bottom: 2px solid #0F382E; padding-bottom: 16px; margin-bottom: 20px;">
          <div style="font-size: 24px; font-weight: 800; color: #0F382E;">Kundasang Homestay</div>
          <div style="font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px;">Official Receipt</div>
        </div>

        <!-- Receipt No. & Booking ID -->
        <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 12px;">
          <div><strong>Receipt No.:</strong> ${receiptNo}</div>
          <div><strong>Booking ID:</strong> ${booking.id}</div>
        </div>

        <!-- Guest & Property -->
        <div style="font-size: 13px; margin-bottom: 16px; border-bottom: 1px dashed #d1d5db; padding-bottom: 12px;">
          <div><strong>Guest:</strong> ${booking.guestName || 'Guest'}</div>
          <div><strong>Homestay:</strong> ${booking.homestay}</div>
          <div><strong>Check‑in:</strong> ${booking.checkin} &nbsp;|&nbsp; <strong>Check‑out:</strong> ${booking.checkout} &nbsp;|&nbsp; <strong>Nights:</strong> ${booking.nights}</div>
        </div>

        <!-- Price Breakdown -->
        <div style="font-size: 13px; margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; padding: 4px 0;">
            <span>Base price (RM ${(base / (booking.nights || 1)).toFixed(2)} × ${booking.nights} nights)</span>
            <span>RM ${base.toFixed(2)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #4b5563;">
            <span>Service Fee</span>
            <span>RM ${fee.toFixed(2)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #4b5563;">
            <span>Gateway fee</span>
            <span>RM ${gatewayFee.toFixed(2)}</span>
          </div>
        </div>

        <!-- Total -->
        <div style="border-top: 2px solid #0F382E; padding-top: 12px; font-size: 16px; font-weight: 700; color: #0F382E; display: flex; justify-content: space-between; margin-bottom: 16px;">
          <span>Total paid</span>
          <span>RM ${total.toFixed(2)}</span>
        </div>

        <!-- Check‑in Code -->
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; text-align: center; margin-bottom: 16px;">
          <div style="font-size: 20px; font-weight: 700; color: #0F382E;">
            🏔️ Your 6‑digit check‑in code: <span style="color: #0F382E;">${booking.checkinCode}</span>
          </div>
          <div style="font-size: 12px; color: #166534; margin-top: 4px;">Please keep this code safe. You will need to share it with the host upon arrival.</div>
        </div>

        <!-- Footer -->
        <div style="text-align: center; font-size: 11px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 12px;">
          Payment via CHIP FPX • Status: Completed<br>
          © ${new Date().getFullYear()} Kundasang Homestay
        </div>
      </div>
    </div>
  `;

  let emailSent = false;
  let emailError = null;

  // Try Resend
  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: booking.guestEmail,
          subject: `Your Receipt ${receiptNo} – Check‑in Code`,
          html: emailHtml
        })
      });
      emailSent = res.ok;
      if (!emailSent) emailError = 'Resend API error';
    } catch (e) {
      emailError = e.message;
    }
  } 
  // Try SendGrid
  else if (env.SENDGRID_API_KEY) {
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: booking.guestEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: `Your Receipt ${receiptNo} – Check‑in Code`,
          content: [{ type: 'text/html', value: emailHtml }]
        })
      });
      emailSent = res.ok;
      if (!emailSent) emailError = 'SendGrid API error';
    } catch (e) {
      emailError = e.message;
    }
  } else {
    emailError = 'No email API key configured';
  }

  return { emailSent, emailError };
}

// ===== The rest of verify-payment.js remains unchanged =====
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

    // ---- ToyyibPay fallback ----
    if (booking.toyyibpay_billcode) {
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

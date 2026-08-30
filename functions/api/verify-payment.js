// /api/verify-payment.js – with email fallback using resend-code HTML
import { corsHeaders } from './_utils.js';

// ===== EMAIL FUNCTION (EXACT COPY from resend-code.js) =====
async function sendCheckinEmail(booking, env) {
  const emailHtml = `
    <h2>Hello ${booking.guestName || 'Guest'},</h2>
    <p>Your booking at <strong>${booking.homestay}</strong> is confirmed!</p>
    <p><strong>Booking ID:</strong> ${booking.id}</p>
    <p><strong>Check‑in:</strong> ${booking.checkin}</p>
    <p><strong>Check‑out:</strong> ${booking.checkout}</p>
    <p><strong>Nights:</strong> ${booking.nights}</p>
    <p><strong>Total Paid:</strong> RM ${Number(booking.total).toFixed(2)}</p>
    <p style="font-size:20px; font-weight:bold; background:#f0fdf4; padding:10px; border-radius:8px; border:1px solid #bbf7d0; display:inline-block;">
      🏔️ Your 6‑digit check‑in code: <span style="color:#0F382E;">${booking.checkinCode}</span>
    </p>
    <p><strong>Please keep this code safe.</strong> You will need to share it with the host when you arrive. Do not share it with anyone else.</p>
    <p>— Kundasang Homestay Team</p>
  `;

  let emailSent = false;
  let emailError = null;

  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'support@kundasanghomestay.my',
          to: booking.guestEmail,
          subject: 'Your Check‑in Code',
          html: emailHtml
        })
      });
      emailSent = res.ok;
      if (!emailSent) emailError = 'Resend API error';
    } catch (e) {
      emailError = e.message;
    }
  } else if (env.SENDGRID_API_KEY) {
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: booking.guestEmail }] }],
          from: { email: env.FROM_EMAIL || 'support@kundasanghomestay.my' },
          subject: 'Your Check‑in Code',
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

async function fetchBillStatus(billcode, secret, retries = 3) {
  const url = `https://dev.toyyibpay.com/index.php/api/getBill?billCode=${billcode}&userSecretKey=${secret}`;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'KundasangHomestay/1.0' },
        cf: { cacheTtl: 0 }
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (e) {
        if (i === retries - 1) throw new Error('Invalid JSON: ' + text.slice(0, 200));
        continue;
      }
      return data;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const raw = await request.text();
    const body = JSON.parse(raw);
    const bookingId = body.bookingId;

    const db = env.DB;
    const r = await db.prepare('SELECT data FROM store WHERE key = ?').bind('kd_bookings').first();
    let bookings = JSON.parse(r?.data || '[]');
    const idx = bookings.findIndex(b => String(b.id) === bookingId);
    if (idx === -1) {
      return new Response(JSON.stringify({ error: 'Booking not found' }), {
        status: 404,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const booking = bookings[idx];
    let paymentStatus = 'pending';
    const statusLower = (booking.status || '').toLowerCase();

    if (statusLower.includes('paid')) paymentStatus = 'paid';
    else if (statusLower.includes('fail')) paymentStatus = 'failed';
    else if (statusLower.includes('pending')) paymentStatus = 'pending';

    // Simulation
    if (booking.toyyibpay_billcode && booking.toyyibpay_billcode.startsWith('SIM-')) {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      
      await sendCheckinEmail(bookings[idx], env);

      return new Response(JSON.stringify({ 
        success: true, 
        booking: bookings[idx],
        paymentStatus: 'paid'
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    if (paymentStatus === 'paid' || paymentStatus === 'failed') {
      if (paymentStatus === 'paid') {
        await sendCheckinEmail(booking, env);
      }
      return new Response(JSON.stringify({ 
        success: paymentStatus === 'paid',
        booking,
        paymentStatus,
        retry: paymentStatus === 'failed' ? true : false
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    if (!booking.toyyibpay_billcode) {
      return new Response(JSON.stringify({ 
        success: false, 
        message: 'No billcode',
        booking,
        paymentStatus: 'pending',
        retry: true
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    const secret = env.TOYYIBPAY_SECRET_KEY;
    if (!secret) {
      return new Response(JSON.stringify({ error: 'Secret missing' }), {
        status: 500,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    let billData;
    try {
      billData = await fetchBillStatus(booking.toyyibpay_billcode, secret, 3);
    } catch (e) {
      return new Response(JSON.stringify({
        success: false,
        message: 'Payment verification pending. Please wait a moment.',
        retry: true,
        booking,
        paymentStatus: 'pending'
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    }

    if (billData && billData[0] && billData[0].billpaymentStatus === "1") {
      bookings[idx].status = 'Paid - Awaiting Check-in';
      bookings[idx].paid_at = new Date().toISOString();
      bookings[idx].toyyibpay_refno = billData[0].billpaymentTransactionId || '';
      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind('kd_bookings', JSON.stringify(bookings)).run();
      
      await sendCheckinEmail(bookings[idx], env);

      return new Response(JSON.stringify({ 
        success: true, 
        booking: bookings[idx],
        paymentStatus: 'paid'
      }), {
        status: 200,
        headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
      });
    } else {
      const billStatus = billData && billData[0] ? billData[0].billpaymentStatus : null;
      if (billStatus === "3") {
        bookings[idx].status = 'Payment Failed';
        await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
          .bind('kd_bookings', JSON.stringify(bookings)).run();
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
          message: 'Payment not yet confirmed. Please wait a moment.',
          retry: true,
          booking: bookings[idx],
          paymentStatus: 'pending'
        }), {
          status: 200,
          headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
        });
      }
    }

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

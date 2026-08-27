// /api/resend-code.js - PATCHED: returns code even if email fails
import { corsHeaders, jsonResponse, getGuestSession, logAction, enforceHttps, getClientIP } from './_utils.js';

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  try {
    const session = await getGuestSession(request, env);
    if (!session) return jsonResponse({ error: 'Unauthorized' }, 401, request);
    
    const { bookingId } = await request.json();
    if (!bookingId) return jsonResponse({ error: 'Missing bookingId' }, 400, request);
    
    const db = env.DB;
    if (!db) return jsonResponse({ error: 'Server error' }, 500, request);
    
    const r = await db.prepare('SELECT data FROM store WHERE key=?').bind('kd_bookings').first();
    let bookings = [];
    try { if (r?.data) bookings = JSON.parse(r.data); } catch(_) {}
    const idx = bookings.findIndex(b => String(b.id) === String(bookingId) && String(b.guestId) === String(session.userId));
    if (idx === -1) return jsonResponse({ error: 'Booking not found' }, 404, request);
    
    const booking = bookings[idx];
    
    // Ensure checkinCode exists
    if (!booking.checkinCode) {
      booking.checkinCode = String(Math.floor(100000 + Math.random() * 900000));
      bookings[idx] = booking;
      await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)')
        .bind('kd_bookings', JSON.stringify(bookings))
        .run();
    }
    
    const code = booking.checkinCode;
    
    // Build email HTML
    const emailHtml = `
      <h2>Hello ${booking.guestName || 'Guest'},</h2>
      <p>Your booking at <strong>${booking.homestay}</strong> is confirmed!</p>
      <p><strong>Booking ID:</strong> ${booking.id}</p>
      <p><strong>Check‑in:</strong> ${booking.checkin}</p>
      <p><strong>Check‑out:</strong> ${booking.checkout}</p>
      <p><strong>Nights:</strong> ${booking.nights}</p>
      <p><strong>Total Paid:</strong> RM ${Number(booking.total).toFixed(2)}</p>
      <p style="font-size:20px; font-weight:bold; background:#f0fdf4; padding:10px; border-radius:8px; border:1px solid #bbf7d0; display:inline-block;">
        🏔️ Your 6‑digit check‑in code: <span style="color:#0F382E;">${code}</span>
      </p>
      <p><strong>Please keep this code safe.</strong> You will need to share it with the host when you arrive. Do not share it with anyone else.</p>
      <p>— Kundasang Homestay Team</p>
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
            subject: 'Your Check‑in Code',
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
    
    // Log the attempt
    await logAction({ 
      db, 
      action: 'code_resent', 
      admin: 'guest', 
      details: `Resent code for ${bookingId} (email sent: ${emailSent})`, 
      ip: getClientIP(request), 
      userId: session.userId 
    });
    
    // Return success with the code (and a warning if email failed)
    return jsonResponse({
      success: true,
      code: code,
      emailSent: emailSent,
      message: emailSent 
        ? 'Check‑in code resent to your email.' 
        : `Check‑in code: ${code}. (Email could not be sent: ${emailError || 'unknown error'})`
    }, 200, request);
    
  } catch(e) {
    console.error('Resend code error:', e);
    return jsonResponse({ error: 'Failed to resend: ' + e.message }, 500, request);
  }
}

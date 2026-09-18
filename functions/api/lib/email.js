// /functions/api/lib/email.js
// Email sending utilities for booking confirmations, payouts, etc.

/**
 * Send host payout email via Resend or SendGrid
 * @param {Object} booking 
 * @param {Object} homestay 
 * @param {Object} payoutInfo 
 * @param {Object} env 
 * @returns {Promise<boolean>}
 */
export async function sendHostPayoutEmail(booking, homestay, payoutInfo, env) {
  try {
    const RESEND_API_KEY = env?.RESEND_API_KEY;
    const SENDGRID_API_KEY = env?.SENDGRID_API_KEY;
    const FROM_EMAIL = env?.FROM_EMAIL || 'noreply@kundasanghomestay.my';
    const SUPPORT_WHATSAPP = env?.SUPPORT_WHATSAPP;

    const subject = `Payout Processed - Booking ${booking.booking_id}`;
    
    let html = `
      <h2>Payout Processed Successfully</h2>
      <p>Dear ${homestay.owner_name || 'Host'},</p>
      <p>Your payout for the following booking has been processed:</p>
      <table style="border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 8px;"><strong>Booking ID:</strong></td><td style="padding: 8px;">${booking.booking_id}</td></tr>
        <tr><td style="padding: 8px;"><strong>Homestay:</strong></td><td style="padding: 8px;">${homestay.name || 'N/A'}</td></tr>
        <tr><td style="padding: 8px;"><strong>Amount:</strong></td><td style="padding: 8px;">RM ${payoutInfo.amount?.toFixed(2) || '0.00'}</td></tr>
        <tr><td style="padding: 8px;"><strong>Transaction ID:</strong></td><td style="padding: 8px;">${payoutInfo.transaction_id || 'N/A'}</td></tr>
        <tr><td style="padding: 8px;"><strong>Date:</strong></td><td style="padding: 8px;">${new Date().toLocaleDateString('en-MY')}</td></tr>
      </table>
      <p>Thank you for using Kundasang Homestay platform.</p>
    `;

    if (SUPPORT_WHATSAPP) {
      html += `
        <div style="margin-top: 20px; padding: 15px; background-color: #25D366; border-radius: 5px;">
          <a href="https://wa.me/${SUPPORT_WHATSAPP}" 
             style="color: white; text-decoration: none; font-weight: bold;">
            💬 Chat with us on WhatsApp
          </a>
        </div>
      `;
    }

    const to = homestay.owner_email || booking.guest_email;
    if (!to) return false;

    // Try Resend first
    if (RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `Kundasang Homestay <${FROM_EMAIL}>`,
          to,
          subject,
          html
        })
      });
      return res.ok;
    }

    // Fallback to SendGrid
    if (SENDGRID_API_KEY) {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: FROM_EMAIL, name: 'Kundasang Homestay' },
          subject,
          content: [{ type: 'text/html', value: html }]
        })
      });
      return res.ok || res.status === 202;
    }

    return false;
  } catch (e) {
    console.error('Failed to send host payout email:', e);
    return false;
  }
}

/**
 * Send payout record email to support for CHIP compliance filing
 * @param {Object} booking 
 * @param {Object} payoutInfo 
 * @param {Object} env 
 * @returns {Promise<boolean>}
 */
export async function sendPayoutRecordEmail(booking, payoutInfo, env) {
  try {
    const RESEND_API_KEY = env?.RESEND_API_KEY;
    const SENDGRID_API_KEY = env?.SENDGRID_API_KEY;
    const FROM_EMAIL = env?.FROM_EMAIL || 'noreply@kundasanghomestay.my';
    const SUPPORT_EMAIL = env?.SUPPORT_EMAIL || 'support@kundasanghomestay.my';

    const subject = `[PAYOUT-RECORD] ${booking.booking_id}`;
    
    const html = `
      <h2>CHIP Payout Record</h2>
      <p>This is an automated record for CHIP compliance filing.</p>
      <table style="border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 8px;"><strong>Booking ID:</strong></td><td style="padding: 8px;">${booking.booking_id}</td></tr>
        <tr><td style="padding: 8px;"><strong>Amount:</strong></td><td style="padding: 8px;">RM ${payoutInfo.amount?.toFixed(2) || '0.00'}</td></tr>
        <tr><td style="padding: 8px;"><strong>Transaction ID:</strong></td><td style="padding: 8px;">${payoutInfo.transaction_id || 'N/A'}</td></tr>
        <tr><td style="padding: 8px;"><strong>Recipient:</strong></td><td style="padding: 8px;">${payoutInfo.recipient_account || 'N/A'}</td></tr>
        <tr><td style="padding: 8px;"><strong>Timestamp:</strong></td><td style="padding: 8px;">${new Date().toISOString()}</td></tr>
      </table>
      <p>Please file this record according to CHIP guidelines.</p>
    `;

    // Try Resend first
    if (RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `Kundasang Homestay <${FROM_EMAIL}>`,
          to: SUPPORT_EMAIL,
          subject,
          html
        })
      });
      return res.ok;
    }

    // Fallback to SendGrid
    if (SENDGRID_API_KEY) {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: SUPPORT_EMAIL }] }],
          from: { email: FROM_EMAIL, name: 'Kundasang Homestay' },
          subject,
          content: [{ type: 'text/html', value: html }]
        })
      });
      return res.ok || res.status === 202;
    }

    return false;
  } catch (e) {
    console.error('Failed to send payout record email:', e);
    return false;
  }
}

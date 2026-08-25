// /api/forgot-password.js - WITH RESEND EMAIL
import { corsHeaders } from './_utils.js';

async function generateResetToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sendResetEmail(email, name, resetUrl, env) {
  try {
    const resendApiKey = env.RESEND_API_KEY;
    const fromEmail = env.FROM_EMAIL || 'support@kundasanghomestay.my';
    
    if (!resendApiKey) {
      console.log('❌ RESEND_API_KEY not set. Email not sent.');
      return false;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: email,
        subject: 'Reset Your Password - Kundasang Homestay',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #0F382E; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
              .content { padding: 30px; background: #f8f5f0; border-radius: 0 0 8px 8px; }
              .button { display: inline-block; background: #3FD0D4; color: white; padding: 12px 30px; text-decoration: none; border-radius: 999px; font-weight: 700; }
              .footer { text-align: center; color: #6b7280; font-size: 12px; margin-top: 30px; }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>🏔️ Kundasang Homestay</h1>
            </div>
            <div class="content">
              <h2>Hello ${name || 'Guest'},</h2>
              <p>You requested to reset your password for your Kundasang Homestay account.</p>
              <p style="text-align: center; margin: 30px 0;">
                <a href="${resetUrl}" class="button">Reset Password</a>
              </p>
              <p>This link will expire in <strong>1 hour</strong>.</p>
              <p>If you didn't request this, please ignore this email.</p>
              <p style="margin-top: 20px;"><strong>⚠️ Security Notice:</strong> Never share this link with anyone.</p>
            </div>
            <div class="footer">
              <p>Kundasang Homestay • Verified Homestays in Sabah</p>
              <p><a href="https://kundasanghomestay.my" style="color: #3FD0D4;">kundasanghomestay.my</a></p>
            </div>
          </body>
          </html>
        `
      })
    });

    if (response.ok) {
      console.log(`✅ Reset email sent to ${email}`);
      return true;
    } else {
      const error = await response.text();
      console.error('❌ Resend API error:', error);
      return false;
    }

  } catch (e) {
    console.error('❌ Email send error:', e.message);
    return false;
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { email, userType } = await request.json();

    if (!email || !userType) {
      return new Response(JSON.stringify({ error: "Missing email or user type" }), {
        status: 400,
        headers: corsHeaders(request)
      });
    }

    const db = env.DB;
    if (!db) {
      return new Response(JSON.stringify({ error: "Server error" }), {
        status: 500,
        headers: corsHeaders(request)
      });
    }

    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    const cleanEmail = email.toLowerCase().trim();
    const token = await generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    let userId = null;
    let userData = null;

    if (userType === 'guest') {
      const r = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
      let guests = [];
      if (r && r.data) { try { guests = JSON.parse(r.data); } catch(e) {} }
      const guest = guests.find(g => g.email && g.email.toLowerCase() === cleanEmail);
      if (!guest) {
        return new Response(JSON.stringify({ success: true, message: "If an account exists, a reset link has been sent." }), {
          status: 200,
          headers: corsHeaders(request)
        });
      }
      userId = guest.id;
      userData = { email: guest.email, name: guest.name, type: 'guest' };
    } else if (userType === 'owner') {
      const r1 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
      let homestays = [];
      if (r1 && r1.data) { try { homestays = JSON.parse(r1.data); } catch(e) {} }
      const r2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if (r2 && r2.data) { try { homestays = [...homestays, ...JSON.parse(r2.data)]; } catch(e) {} }

      const owner = homestays.find(h => h.ownerEmail && h.ownerEmail.toLowerCase() === cleanEmail);
      if (!owner) {
        return new Response(JSON.stringify({ success: true, message: "If an account exists, a reset link has been sent." }), {
          status: 200,
          headers: corsHeaders(request)
        });
      }
      userId = owner.id;
      userData = { email: owner.ownerEmail, name: owner.ownerName, type: 'owner', homestayName: owner.name };
    } else {
      return new Response(JSON.stringify({ error: "Invalid user type" }), {
        status: 400,
        headers: corsHeaders(request)
      });
    }

    // Ensure password_resets table exists with indexes
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS password_resets (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_type TEXT NOT NULL,
        email TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER DEFAULT 0
      )
    `).run();

    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_token ON password_resets(token)`).run().catch(() => {});
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_expires ON password_resets(expires_at)`).run().catch(() => {});

    await db.prepare(`
      INSERT OR REPLACE INTO password_resets (token, user_id, user_type, email, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(token, userId, userType, cleanEmail, expiresAt).run();

    const domain = env.PUBLIC_DOMAIN || 'https://kundasanghomestay.my';
    const resetUrl = `${domain}/reset-password.html?token=${token}&type=${userType}`;

    console.log(`🔐 Reset link for ${cleanEmail}: ${resetUrl}`);

    // Send email
    const emailSent = await sendResetEmail(cleanEmail, userData.name, resetUrl, env);

    return new Response(JSON.stringify({
      success: true,
      message: emailSent ? "Reset link sent to your email." : "Reset link generated. (Check server logs for URL)",
      resetUrl: env.ENVIRONMENT === 'development' ? resetUrl : undefined
    }), {
      status: 200,
      headers: corsHeaders(request)
    });

  } catch (e) {
    console.error("❌ Forgot password error:", e.message);
    return new Response(JSON.stringify({ error: "Failed to process request" }), {
      status: 500,
      headers: corsHeaders(request)
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

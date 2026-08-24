// /functions/api/reset-password.js - Reset password with token
import { corsHeaders, sha256, generateSalt } from './_utils.js';

const PEPPER = "kundasang-homestay-2026";

export async function onRequestPost({ request, env }) {
  try {
    const { token, password, userType } = await request.json();

    if (!token || !password || !userType) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: corsHeaders(request)
      });
    }

    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), {
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

    // ✅ Ensure store table exists (for updating guests/owners)
    await db.prepare("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)").run();

    // Verify token
    const r = await db.prepare(`
      SELECT * FROM password_resets WHERE token = ? AND used = 0 AND expires_at > datetime('now')
    `).bind(token).first();

    if (!r) {
      return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
        status: 400,
        headers: corsHeaders(request)
      });
    }

    await db.prepare(`UPDATE password_resets SET used = 1 WHERE token = ?`).bind(token).run();

    if (userType === 'guest') {
      const guestsR = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_guests").first();
      let guests = [];
      if (guestsR && guestsR.data) { try { guests = JSON.parse(guestsR.data); } catch(e) {} }

      const idx = guests.findIndex(g => g.id === r.user_id);
      if (idx === -1) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: corsHeaders(request)
        });
      }

      // ✅ FIXED: Use PEPPER in hash
      const salt = generateSalt();
      const hashedPassword = await sha256(PEPPER + password + salt);

      guests[idx].password = hashedPassword;
      guests[idx].salt = salt;
      guests[idx].passwordUpdated = new Date().toISOString();

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_guests", JSON.stringify(guests))
        .run();

    } else if (userType === 'owner') {
      const r1 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_approved").first();
      let homestays = [];
      if (r1 && r1.data) { try { homestays = JSON.parse(r1.data); } catch(e) {} }
      const r2 = await db.prepare("SELECT data FROM store WHERE key = ?").bind("kd_pending").first();
      if (r2 && r2.data) { try { homestays = [...homestays, ...JSON.parse(r2.data)]; } catch(e) {} }

      const idx = homestays.findIndex(h => String(h.id) === String(r.user_id));
      if (idx === -1) {
        return new Response(JSON.stringify({ error: "Owner not found" }), {
          status: 404,
          headers: corsHeaders(request)
        });
      }

      // ✅ FIXED: Use PEPPER in hash
      const salt = generateSalt();
      const hashedPassword = await sha256(PEPPER + password + salt);

      homestays[idx].ownerPasswordHash = hashedPassword;
      homestays[idx].ownerSalt = salt;
      homestays[idx].passwordUpdated = new Date().toISOString();

      const approved = homestays.filter(h => h.approved === true || h.verified === true);
      const pending = homestays.filter(h => h.approved === false && h.verified === false);

      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_approved", JSON.stringify(approved))
        .run();
      await db.prepare("INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)")
        .bind("kd_pending", JSON.stringify(pending))
        .run();

    } else {
      return new Response(JSON.stringify({ error: "Invalid user type" }), {
        status: 400,
        headers: corsHeaders(request)
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: "Password reset successful. You can now log in."
    }), {
      status: 200,
      headers: corsHeaders(request)
    });

  } catch (e) {
    console.error("❌ Reset password error:", e.message);
    return new Response(JSON.stringify({ error: "Failed to reset password" }), {
      status: 500,
      headers: corsHeaders(request)
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

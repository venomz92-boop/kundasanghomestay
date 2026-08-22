// /api/admin-login.js - Login endpoint for admin

export async function onRequestPost({ request, env }) {
  try {
    const { password } = await request.json();
    const adminPass = env.ADMIN_PASSWORD || "admin123";
    if (password === adminPass) {
      // Simple token (use JWT in production)
      const token = btoa(JSON.stringify({ user: "admin", ts: Date.now() }));
      return new Response(JSON.stringify({ success: true, token }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...cors() }
      });
    } else {
      return new Response(JSON.stringify({ error: "Wrong password" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...cors() }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...cors() }
    });
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
export async function onRequestOptions() {
  return new Response(null, { headers: cors() });
}
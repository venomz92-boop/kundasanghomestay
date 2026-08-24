// /api/admin-login.js - COMPLETE with security fixes
import { corsHeaders, getClientIP, enforceHttps } from './_utils.js';

const loginAttempts = new Map();

function checkRateLimit(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const attempts = loginAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
  if (recent.length >= 5) {
    return { blocked: true, remaining: 0 };
  }
  return { blocked: false, remaining: 5 - recent.length };
}

function recordLoginAttempt(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const attempts = loginAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
  recent.push(now);
  loginAttempts.set(key, recent);
}

export async function onRequestPost({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;
  
  try {
    const clientIP = getClientIP(request);
    
    const rateLimit = checkRateLimit(clientIP);
    if (rateLimit.blocked) {
      return new Response(JSON.stringify({ 
        error: "Too many login attempts. Please wait 15 minutes." 
      }), {
        status: 429,
        headers: corsHeaders(request)
      });
    }

    const { password } = await request.json();

    if (!password || typeof password !== 'string') {
      recordLoginAttempt(clientIP);
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 400,
        headers: corsHeaders(request)
      });
    }

    const adminPass = env.ADMIN_PASSWORD;
    if (!adminPass) {
      console.error("❌ ADMIN_PASSWORD environment variable is not set!");
      return new Response(JSON.stringify({ 
        error: "Server configuration error. Please contact support." 
      }), {
        status: 500,
        headers: corsHeaders(request)
      });
    }

    if (password === adminPass) {
      loginAttempts.delete(clientIP);
      const token = env.ADMIN_TOKEN;
      
      console.log(`✅ Admin login successful (IP: ${clientIP})`);
      
      return new Response(JSON.stringify({ 
        success: true, 
        token: token,
        message: "Login successful"
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': `admin_token=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=86400; Path=/`,
          ...corsHeaders(request)
        }
      });
    } else {
      recordLoginAttempt(clientIP);
      return new Response(JSON.stringify({ 
        error: "Invalid credentials"
      }), {
        status: 401,
        headers: corsHeaders(request)
      });
    }
    
  } catch (e) {
    console.error("❌ Admin login error:", e.message);
    return new Response(JSON.stringify({ 
      error: "Login failed. Please try again later." 
    }), {
      status: 500,
      headers: corsHeaders(request)
    });
  }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

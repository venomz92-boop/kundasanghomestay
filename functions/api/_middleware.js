// /api/_middleware.js
//
// Runs for every request under /api/*.
//
// Jobs:
//   1. Force HTTPS on http:// requests.
//   2. Catch and log any 5xx response or uncaught error to the
//      kd_errors store, so the admin panel can display them.
//
// The error log is capped at 200 entries and deduplicates by
// (method + endpoint + first 200 chars of message). If the same
// error repeats within a 5-minute window, the count is bumped
// instead of adding a new row.
//
// Logging failures NEVER break the response — they are swallowed.

const ERRORS_KEY = 'kd_errors';
const MAX_ERRORS = 200;
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function shortenStack(stack) {
  if (!stack || typeof stack !== 'string') return '';
  return stack.slice(0, 2000);
}

function signatureFor(method, endpoint, message) {
  const m = String(message || '').slice(0, 200);
  return `${method}::${endpoint}::${m}`;
}

async function logApiError(context, info) {
  const { env, waitUntil } = context;
  if (!env || !env.DB) return;

  const work = (async () => {
    try {
      const db = env.DB;
      await db.prepare('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, data TEXT)').run();

      const r = await db.prepare('SELECT data FROM store WHERE key=?').bind(ERRORS_KEY).first();
      let errors = [];
      try { if (r?.data) errors = JSON.parse(r.data); } catch (_) {}
      if (!Array.isArray(errors)) errors = [];

      const sig = signatureFor(info.method, info.endpoint, info.message);
      const now = Date.now();
      const nowIso = new Date(now).toISOString();

      const idx = errors.findIndex(e => {
        if (e.signature !== sig) return false;
        const last = e.last_seen ? new Date(e.last_seen).getTime() : 0;
        return (now - last) < DEDUPE_WINDOW_MS;
      });

      if (idx !== -1) {
        errors[idx].count = (errors[idx].count || 1) + 1;
        errors[idx].last_seen = nowIso;
      } else {
        errors.push({
          id: 'ERR-' + now + '-' + Math.random().toString(36).slice(2, 8),
          signature: sig,
          method: info.method || 'GET',
          endpoint: info.endpoint || '/',
          status: info.status || 500,
          message: String(info.message || 'Unknown error').slice(0, 500),
          sample_stack: shortenStack(info.stack || ''),
          sample_ip: String(info.ip || 'unknown').slice(0, 45),
          count: 1,
          first_seen: nowIso,
          last_seen: nowIso
        });
      }

      // Cap size, keeping the newest MAX_ERRORS entries.
      if (errors.length > MAX_ERRORS) {
        errors = errors
          .slice()
          .sort((a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0))
          .slice(0, MAX_ERRORS);
      }

      await db.prepare('INSERT OR REPLACE INTO store (key, data) VALUES (?, ?)')
        .bind(ERRORS_KEY, JSON.stringify(errors))
        .run();
    } catch (_) {
      // Never let error logging break the app.
    }
  })();

  if (typeof waitUntil === 'function') {
    waitUntil(work);
  } else {
    // Fallback: await, so the log is written before the response is
    // returned. Slightly slower, but reliable.
    await work;
  }
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // ---- 1. Force HTTPS ----
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return new Response(null, {
      status: 301,
      headers: { Location: url.toString() }
    });
  }

  // ---- 2. Skip logging for the errors endpoint itself ----
  // (Avoids infinite loop if the errors endpoint 5xx's.)
  if (url.pathname === '/api/admin-errors') {
    return next();
  }

  const clientIP =
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown';

  try {
    const response = await next();

    // Log any 5xx response. Endpoints that catch their own errors
    // and return jsonResponse(..., 500, ...) show up here.
    if (response && response.status >= 500) {
      let message = 'Server error';
      try {
        const clone = response.clone();
        const text = await clone.text();
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed.error === 'string') message = parsed.error;
            else if (parsed && typeof parsed.message === 'string') message = parsed.message;
          } catch (_) {
            message = text.slice(0, 200);
          }
        }
      } catch (_) {}

      await logApiError(context, {
        method: request.method,
        endpoint: url.pathname,
        status: response.status,
        message,
        stack: '',
        ip: clientIP
      });
    }

    return response;
  } catch (err) {
    // Uncaught error from downstream handler.
    const message = (err && err.message) ? err.message : String(err);
    await logApiError(context, {
      method: request.method,
      endpoint: url.pathname,
      status: 500,
      message,
      stack: err && err.stack ? err.stack : '',
      ip: clientIP
    });
    throw err;
  }
}

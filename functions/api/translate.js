// functions/api/translate.js
// Same-origin translation proxy — bypasses the browser CSP legally.
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const q  = url.searchParams.get('q')  || '';
  const tl = url.searchParams.get('tl') || 'en';
  if (!q) {
    return new Response(JSON.stringify({ error: 'Missing q' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const upstream =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    encodeURIComponent(tl) + '&dt=t&q=' + encodeURIComponent(q);
  const up = await fetch(upstream);
  const body = await up.text();
  return new Response(body, {
    status: up.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400'
    }
  });
}

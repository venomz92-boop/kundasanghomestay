// api/translate.js — same-origin translation proxy (bypasses browser CSP)
const https = require('https');

module.exports = async function handler(req, res) {
  const q  = String((req.query && req.query.q)  || '');
  const tl = String((req.query && req.query.tl) || 'en');
  if (!q || !tl) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Missing q or tl' }));
  }
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
              encodeURIComponent(tl) + '&dt=t&q=' + encodeURIComponent(q);

  https.get(url, (up) => {
    let body = '';
    up.on('data', (c) => (body += c));
    up.on('end', () => {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Content-Type', 'application/json');
      res.end(body);   // pass Google's JSON through unchanged
    });
  }).on('error', () => {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'translate upstream failed' }));
  });
};

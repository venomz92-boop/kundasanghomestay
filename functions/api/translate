// ===== TRANSLATION PROXY (CSP-safe, same-origin) =====
app.get('/api/translate', async (req, res) => {
  try {
    const q  = String(req.query.q  || '');
    const tl = String(req.query.tl || 'en');
    if (!q || !tl) return res.status(400).json({ error: 'Missing q or tl' });
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
                encodeURIComponent(tl) + '&dt=t&q=' + encodeURIComponent(q);
    const up = await fetch(url);            // Node 18+ global fetch
    const data = await up.json();
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'translate upstream failed' });
  }
});

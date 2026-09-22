/* ============================================================
   Kundasang Homestay — Free Auto-Translator (client-side)
   ------------------------------------------------------------
   Engine : Google "gtx" public endpoint (free, no API key) —
            same quality as translate.google.com.
   Cost   : RM0. No signup. No server changes.
   Behaviour:
     - Floating 🌐 pill (above the mobile bottom nav).
     - Translates visible text only (never scripts, inputs,
       price-only strings, form controls).
     - Caches every segment in localStorage → repeat visits are
       instant and make zero network calls.
     - MutationObserver auto-translates content injected later
       (listing grid, detail modal, booking summary, toasts).
     - Switching back to English restores originals in place,
       without a reload (safe mid-booking).
   Upgrade path (official SLA / unlimited volume):
     CONFIG.mode = 'libre'  + self-host LibreTranslate (free, Docker), or
     CONFIG.mode = 'azure'  + tiny /api/translate proxy (Azure free tier).
   Protect any element from translation: add class="notranslate".
   ============================================================ */
(function () {
  'use strict';

  var CONFIG = {
    mode: 'gtx',                 // 'gtx' | 'libre'
    libreUrl: '',                // e.g. 'https://translate.yourdomain.com'
    languages: [
      ['en',    'English'],
      ['ms',    'Bahasa Melayu'],
      ['zh-CN', '中文 (简体)'],
      ['ja',    '日本語'],
      ['ko',    '한국어']
    ],
    batchSize: 80                // text segments per request
  };

  var LANG_KEY  = 'kd_lang';
  var CACHE_KEY = 'kd_tr_cache_v1';
  var current   = localStorage.getItem(LANG_KEY) || 'en';
  var cache     = readCache();

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
  }

  /* ---------- floating language pill ---------- */
  function buildUI() {
    var wrap = document.createElement('div');
    wrap.id = 'kdTranslator';
    wrap.className = 'notranslate';
    wrap.setAttribute('translate', 'no');
    wrap.style.cssText =
      'position:fixed;right:14px;bottom:92px;z-index:45;' +
      'display:flex;align-items:center;gap:6px;' +
      'background:rgba(255,255,255,.95);backdrop-filter:blur(8px);' +
      'border:1px solid rgba(0,0,0,.08);border-radius:999px;' +
      'padding:6px 10px;box-shadow:0 6px 20px rgba(0,0,0,.12);' +
      'font-family:Poppins,sans-serif;';
    wrap.innerHTML =
      '<span style="font-size:14px;line-height:1;">🌐</span>' +
      '<select id="kdLangSelect" style="border:none;background:transparent;font:600 12px Poppins,sans-serif;color:#212121;outline:none;"></select>';
    document.body.appendChild(wrap);
    var sel = wrap.querySelector('#kdLangSelect');
    CONFIG.languages.forEach(function (l) {
      var o = document.createElement('option');
      o.value = l[0]; o.textContent = l[1];
      sel.appendChild(o);
    });
    sel.value = current;
    sel.addEventListener('change', function () {
      current = sel.value;
      localStorage.setItem(LANG_KEY, current);
      if (current === 'en') restoreAll(); else translatePage(document.body);
    });
    if (window.matchMedia('(min-width:1024px)').matches) wrap.style.bottom = '24px';
  }

  /* ---------- DOM walking ---------- */
  var SKIP = {SCRIPT:1,STYLE:1,NOSCRIPT:1,TEXTAREA:1,INPUT:1,SELECT:1,OPTION:1,CODE:1,PRE:1,SVG:1,PATH:1,CANVAS:1,IFRAME:1,HEAD:1};
  function walk(root, fn) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP[p.tagName]) return NodeFilter.FILTER_REJECT;
        if (p.closest('.notranslate,[data-notranslate],#kdTranslator')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n; while ((n = w.nextNode())) fn(n);
  }
  function isTranslatable(t) {
    var s = t.trim();
    if (!s || s.length < 2) return false;
    // skip pure numbers / prices / dates / symbols (no letters at all)
    if (!/[a-zA-Z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)) return false;
    return true;
  }
  function collectBatch(root) {
    var nodes = [], texts = [];
    walk(root, function (n) {
      if (n.__kdOrig != null) return;               // already translated
      if (!isTranslatable(n.nodeValue)) return;
      nodes.push(n); texts.push(n.nodeValue.trim());
    });
    return { nodes: nodes, texts: texts };
  }

  /* ---------- translation engine ---------- */
  function cacheKey(text) { return current + '|' + text; }

  function fetchTranslations(texts) {
    var q = texts.join('\n');
    if (CONFIG.mode === 'libre' && CONFIG.libreUrl) {
      return fetch(CONFIG.libreUrl + '/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: q, source: 'auto', target: current, format: 'text' })
      }).then(function (r) { return r.json(); })
        .then(function (d) { return String(d.translatedText || '').split('\n'); });
    }
    var url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
              encodeURIComponent(current) + '&dt=t&q=' + encodeURIComponent(q);
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('translate http ' + res.status);
      return res.json();
    }).then(function (data) {
      var joined = '';
      (data[0] || []).forEach(function (seg) { joined += seg[0] || ''; });
      return joined.split('\n');
    });
  }

  function requestBatch(texts) {
    var out = new Array(texts.length), missing = [];
    texts.forEach(function (t, i) {
      var c = cache[current + '|' + t];
      if (c != null) out[i] = c; else missing.push([t, i]);
    });
    if (!missing.length) return Promise.resolve(out);
    var payload = missing.map(function (m) { return m[0]; });
    return fetchTranslations(payload).then(function (results) {
      if (!results || results.length !== payload.length) {
        // Batch shape mismatch → safe per-segment fallback for this batch only
        return payload.reduce(function (chain, text, k) {
          return chain.then(function () {
            return fetchTranslations([text]).then(function (r) {
              results[k] = (r && r[0] != null) ? r[0] : text;
            });
          });
        }, Promise.resolve()).then(function () { return results; });
      }
      return results;
    }).then(function (results) {
      missing.forEach(function (m, idx) {
        cache[current + '|' + m[0]] = results[idx];
        out[m[1]] = results[idx];
      });
      saveCache();
      return out;
    });
  }

  function translatePage(root) {
    if (current === 'en') return Promise.resolve();
    root = root || document.body;
    var batch = collectBatch(root);
    if (!batch.texts.length) return Promise.resolve();
    var chain = Promise.resolve();
    for (var i = 0; i < batch.texts.length; i += CONFIG.batchSize) {
      (function (start) {
        chain = chain.then(function () {
          var sliceT = batch.texts.slice(start, start + CONFIG.batchSize);
          var sliceN = batch.nodes.slice(start, start + CONFIG.batchSize);
          return requestBatch(sliceT).then(function (res) {
            sliceN.forEach(function (n, idx) {
              if (res[idx] == null) return;
              if (n.__kdOrig == null) n.__kdOrig = n.nodeValue;
              n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), res[idx]);
            });
          }).catch(function (e) {
            console.warn('[translator] batch failed — staying in current text', e);
          });
        });
      })(i);
    }
    return chain;
  }

  function restoreAll() {
    walk(document.body, function (n) {
      if (n.__kdOrig != null) { n.nodeValue = n.__kdOrig; n.__kdOrig = null; }
    });
  }

  /* ---------- auto-translate content injected later ---------- */
  if (window.MutationObserver) {
    var t;
    new MutationObserver(function () {
      if (current === 'en') return;
      clearTimeout(t);
      t = setTimeout(function () { translatePage(document.body); }, 350);
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ---------- boot ---------- */
  function boot() {
    buildUI();
    if (current !== 'en') translatePage(document.body);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.kdRetranslate = function () { return translatePage(document.body); };
})();

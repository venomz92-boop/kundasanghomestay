/* ============================================================
   Kundasang Homestay — Free Auto-Translator v2 (CSP-safe)
   - Primary engine: same-origin proxy /api/translate (never
     blocked by Content-Security-Policy connect-src).
   - Fallback: direct Google gtx endpoint (works only if your
     CSP allows connect-src https://translate.googleapis.com).
   - NEVER fails silently: shows a toast + console error.
   ============================================================ */
(function () {
  'use strict';

  var CONFIG = {
    mode: 'auto',                 // 'auto' | 'proxy' | 'gtx'
    proxyUrl: '/api/translate',   // same-origin proxy (see server snippet)
    languages: [
      ['en',    'English'],
      ['ms',    'Bahasa Melayu'],
      ['zh-CN', '中文 (简体)'],
      ['ja',    '日本語'],
      ['ko',    '한국어']
    ],
    batchSize: 80
  };

  var LANG_KEY  = 'kd_lang';
  var CACHE_KEY = 'kd_tr_cache_v2';
  var current   = localStorage.getItem(LANG_KEY) || 'en';
  var cache     = readCache();
  var proxyBroken = false;        // set true after first proxy 404/network error
  var errorShown  = false;

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
  }

  /* ---------- visible error toast (never fail silently) ---------- */
  function showError(msg) {
    console.error('[translator] ' + msg);
    if (errorShown) return;
    errorShown = true;
    var t = document.createElement('div');
    t.style.cssText =
      'position:fixed;left:50%;bottom:100px;transform:translateX(-50%);z-index:99999;' +
      'background:#b91c1c;color:#fff;padding:12px 20px;border-radius:999px;' +
      'font:600 12px Poppins,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3);' +
      'max-width:calc(100vw - 32px);text-align:center;';
    t.textContent = 'Translation unavailable: ' + msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 6000);
  }

  /* ---------- floating language pill ---------- */
  function buildUI() {
    var style = document.createElement('style');
    style.textContent =
      '#kdTranslator{position:fixed;right:14px;bottom:92px;z-index:45;' +
      'display:flex;align-items:center;gap:6px;' +
      'background:rgba(255,255,255,.95);backdrop-filter:blur(8px);' +
      '-webkit-backdrop-filter:blur(8px);' +
      'border:1px solid rgba(0,0,0,.08);border-radius:999px;' +
      'padding:6px 10px;box-shadow:0 6px 20px rgba(0,0,0,.12);' +
      'font-family:Poppins,sans-serif;}' +
      '@media(min-width:1024px){#kdTranslator{bottom:24px;}}' +
      '#kdLangSelect{border:none;background:transparent;' +
      'font:600 12px Poppins,sans-serif;color:#212121;outline:none;}';
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.id = 'kdTranslator';
    wrap.className = 'notranslate';
    wrap.setAttribute('translate', 'no');
    wrap.innerHTML =
      '<span style="font-size:14px;line-height:1;">🌐</span>' +
      '<select id="kdLangSelect" aria-label="Select language"></select>';
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
      errorShown = false;
      localStorage.setItem(LANG_KEY, current);
      document.documentElement.lang = current;
      if (current === 'en') restoreAll(); else translatePage(document.body);
    });
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
    if (!/[a-zA-Z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)) return false;
    return true;
  }
  function collectBatch(root) {
    var nodes = [], texts = [];
    walk(root, function (n) {
      if (n.__kdOrig != null) return;
      if (!isTranslatable(n.nodeValue)) return;
      nodes.push(n); texts.push(n.nodeValue.trim());
    });
    return { nodes: nodes, texts: texts };
  }

  /* ---------- engines ---------- */
  function parseGoogleShape(data) {
    if (Array.isArray(data)) {                 // Google gtx shape
      var joined = '';
      (data[0] || []).forEach(function (seg) { joined += seg[0] || ''; });
      return joined.split('\n');
    }
    if (data && typeof data.translatedText === 'string') {  // Libre shape
      return data.translatedText.split('\n');
    }
    return null;
  }

  function viaProxy(q) {
    return fetch(CONFIG.proxyUrl + '?tl=' + encodeURIComponent(current) + '&q=' + encodeURIComponent(q))
      .then(function (r) {
        if (r.status === 404) { proxyBroken = true; throw new Error('proxy-missing'); }
        if (!r.ok) throw new Error('proxy http ' + r.status);
        return r.json();
      })
      .then(parseGoogleShape);
  }

  function viaGtx(q) {
    var url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
              encodeURIComponent(current) + '&dt=t&q=' + encodeURIComponent(q);
    return fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('gtx http ' + r.status); return r.json(); })
      .then(parseGoogleShape);
  }

  function fetchTranslations(texts) {
    var q = texts.join('\n');
    if (CONFIG.mode === 'proxy') return viaProxy(q);
    if (CONFIG.mode === 'gtx')   return viaGtx(q);
    // auto: proxy first (CSP-safe), fall back to direct Google
    if (proxyBroken) return viaGtx(q);
    return viaProxy(q).catch(function (e) {
      if (e && e.message === 'proxy-missing') return viaGtx(q);
      return viaGtx(q);
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
          });
        });
      })(i);
    }
    return chain.catch(function (e) {
      showError((e && e.message) || 'translation request failed');
    });
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
    document.documentElement.lang = current;
    if (current !== 'en') translatePage(document.body);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.kdRetranslate = function () { return translatePage(document.body); };
})();

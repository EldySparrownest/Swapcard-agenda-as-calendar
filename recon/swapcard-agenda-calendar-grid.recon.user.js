// ==UserScript==
// @name         Swapcard Agenda Calendar Grid — Recon
// @namespace    https://github.com/EldySparrownest/Swapcard-agenda-as-calendar
// @version      0.1.2
// @description  Passively records Swapcard's own network traffic so we can learn the agenda API shape. Records only; never modifies a request or response.
// @author       Sparrownest
// @match        https://app.swapcard.com/*
// @match        https://*.swapcard.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * WHAT THIS DOES
 * --------------
 * Wraps window.fetch and XMLHttpRequest before Swapcard's bundle loads, then logs every
 * request/response pair that looks like an API call. Everything is passed through
 * untouched -- this is a tap, not a proxy.
 *
 * HOW TO USE
 * ----------
 *   1. Install in Tampermonkey, then load the agenda page:
 *        https://app.swapcard.com/event/<slug>/plannings/<viewId>
 *   2. Scroll the agenda to the very bottom so every page of sessions is fetched.
 *      Click through each day tab too, if the agenda has them.
 *   3. Visit /my-schedule?view=schedule as well, so we also capture how Swapcard
 *      identifies the sessions you have already picked.
 *   4. Back in the console, run:  __SACG.dump()
 *      -> downloads swapcard-recon-<timestamp>.json
 *
 * The dump is REDACTED: Authorization headers, cookies, and any JWT- or token-shaped
 * value are replaced with a placeholder before the file is written. Verify for yourself
 * with:  grep -c "eyJ" swapcard-recon-*.json   (expected: 0)
 */

(function () {
  'use strict';

  var MAX_BODY_CHARS = 2000000; // per response; plenty for a full agenda page
  var log = [];
  var seq = 0;

  // ---------------------------------------------------------------- redaction

  // A JWT: three base64url segments, the first being a base64 JSON header (starts "eyJ").
  var JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g;
  var SECRET_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization)$/i;
  var SECRET_KEYS = /(token|password|secret|authorization|cookie|apikey|api_key|credential)/i;

  function redactString(s) {
    if (typeof s !== 'string') return s;
    return s.replace(JWT_RE, '<REDACTED_JWT>');
  }

  // Deep clone with secrets stripped. Handles cycles.
  function redact(value, seen) {
    seen = seen || new WeakSet();
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '<CYCLE>';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map(function (v) { return redact(v, seen); });
    }
    var out = {};
    Object.keys(value).forEach(function (k) {
      if (SECRET_KEYS.test(k)) {
        // Keep the key so we know the auth scheme exists, drop the value.
        out[k] = typeof value[k] === 'string'
          ? '<REDACTED:' + value[k].length + ' chars>'
          : '<REDACTED>';
        return;
      }
      out[k] = redact(value[k], seen);
    });
    return out;
  }

  function redactHeaders(h) {
    var out = {};
    Object.keys(h || {}).forEach(function (k) {
      out[k] = SECRET_HEADERS.test(k)
        ? '<REDACTED:' + String(h[k]).length + ' chars>'
        : redactString(String(h[k]));
    });
    return out;
  }

  // ---------------------------------------------------------------- helpers

  function isInteresting(url) {
    if (typeof url !== 'string') return false;
    if (/\/_next\/static\//.test(url)) return false;
    if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(url)) return false;
    return /graphql|\/api\/|swapcard\.com/i.test(url);
  }

  function parseMaybeJson(text) {
    if (typeof text !== 'string') return text;
    var t = text.trim();
    if (!t || (t.charAt(0) !== '{' && t.charAt(0) !== '[')) return text.slice(0, 500);
    try { return JSON.parse(t); } catch (e) { return text.slice(0, 500); }
  }

  // Pull the GraphQL operation name(s) out of a request body, for a readable index.
  function opNames(body) {
    var ops = [];
    var arr = Array.isArray(body) ? body : [body];
    arr.forEach(function (b) {
      if (!b || typeof b !== 'object') return;
      if (b.operationName) { ops.push(b.operationName); return; }
      if (typeof b.query === 'string') {
        var m = b.query.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/);
        if (m) ops.push(m[1]);
      }
    });
    return ops;
  }

  function headersToObject(h) {
    var out = {};
    if (!h) return out;
    if (Array.isArray(h)) {
      h.forEach(function (pair) { out[pair[0]] = pair[1]; });
      return out;
    }
    if (typeof h.forEach === 'function') {
      // Headers instance
      try {
        h.forEach(function (v, k) { out[k] = v; });
        return out;
      } catch (e) { /* fall through */ }
    }
    return Object.assign({}, h);
  }

  function record(entry) {
    entry.n = ++seq;
    entry.t = new Date().toISOString();
    log.push(entry);
    updateBadge();
  }

  // ---------------------------------------------------------------- fetch tap

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url, method, reqHeaders, reqBody;
      try {
        if (input && typeof input === 'object' && 'url' in input) {
          url = input.url;
          method = (init && init.method) || input.method || 'GET';
          reqHeaders = headersToObject((init && init.headers) || input.headers);
        } else {
          url = String(input);
          method = (init && init.method) || 'GET';
          reqHeaders = headersToObject(init && init.headers);
        }
        reqBody = init && init.body;
      } catch (e) { /* never break the page */ }

      var promise = origFetch.apply(this, arguments);

      try {
        if (!isInteresting(url)) return promise;
      } catch (e) { return promise; }

      return promise.then(function (res) {
        try {
          res.clone().text().then(function (text) {
            try {
              var parsedReq = typeof reqBody === 'string' ? parseMaybeJson(reqBody) : undefined;
              record({
                via: 'fetch',
                url: url,
                method: method,
                status: res.status,
                ops: opNames(parsedReq),
                requestHeaders: redactHeaders(reqHeaders),
                requestBody: redact(parsedReq),
                responseBody: redact(parseMaybeJson(text.slice(0, MAX_BODY_CHARS))),
                truncated: text.length > MAX_BODY_CHARS
              });
            } catch (e) { /* ignore */ }
          }).catch(function () {});
        } catch (e) { /* ignore */ }
        return res;
      });
    };
  }

  // ---------------------------------------------------------------- XHR tap

  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    var origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      this.__sacg = { method: method, url: url, headers: {} };
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (k, v) {
      try { if (this.__sacg) this.__sacg.headers[k] = v; } catch (e) { /* ignore */ }
      return origSetHeader.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      var self = this;
      try {
        if (self.__sacg && isInteresting(self.__sacg.url)) {
          self.addEventListener('load', function () {
            try {
              var parsedReq = typeof body === 'string' ? parseMaybeJson(body) : undefined;
              var text = '';
              try {
                if (self.responseType === '' || self.responseType === 'text') text = self.responseText;
              } catch (e) { /* ignore */ }
              record({
                via: 'xhr',
                url: self.__sacg.url,
                method: self.__sacg.method,
                status: self.status,
                ops: opNames(parsedReq),
                requestHeaders: redactHeaders(self.__sacg.headers),
                requestBody: redact(parsedReq),
                responseBody: redact(parseMaybeJson(String(text).slice(0, MAX_BODY_CHARS)))
              });
            } catch (e) { /* ignore */ }
          });
        }
      } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------- HUD badge

  var badge = null;

  function updateBadge() {
    if (!badge) return;
    var counts = {};
    log.forEach(function (e) {
      (e.ops || []).forEach(function (o) { counts[o] = (counts[o] || 0) + 1; });
    });
    var names = Object.keys(counts);
    badge.textContent = 'Recon: ' + log.length + ' calls, ' + names.length + ' ops';
    badge.title = names.length ? names.join('\n') : 'no GraphQL operations seen yet';
  }

  function mountBadge() {
    if (badge || !document.body) return;
    badge = document.createElement('div');
    badge.id = 'sacg-recon-badge';
    badge.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'bottom:12px', 'right:12px',
      'background:#2E8A87', 'color:#fff', 'font:12px/1.4 system-ui,sans-serif',
      'padding:6px 10px', 'border-radius:6px', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.3)', 'user-select:none'
    ].join(';');
    badge.addEventListener('click', function () { window.__SACG.dump(); });
    document.body.appendChild(badge);
    updateBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBadge);
  } else {
    mountBadge();
  }

  // ---------------------------------------------------------------- public API

  window.__SACG = {
    get log() { return log; },

    // Operation-name -> call count, for a quick "did I capture it?" check.
    ops: function () {
      var counts = {};
      log.forEach(function (e) {
        (e.ops || []).forEach(function (o) { counts[o] = (counts[o] || 0) + 1; });
      });
      console.table(counts);
      return counts;
    },

    clear: function () { log = []; seq = 0; updateBadge(); },

    dump: function () {
      var payload = {
        capturedAt: new Date().toISOString(),
        href: location.href,
        userAgent: navigator.userAgent,
        // Deliberately does not spell out the JWT prefix -- otherwise this very string
        // would trip the grep the README tells you to run.
        note: 'Auth headers and JWT-shaped values are redacted. See README for how to verify.',
        calls: log
      };
      // Belt and braces: re-scan the serialized output for anything JWT-shaped.
      var text = redactString(JSON.stringify(payload, null, 2));
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'swapcard-recon-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
      console.log('[SACG] dumped ' + log.length + ' calls');
      return payload;
    }
  };

  console.log('[SACG] recon armed. Browse the agenda, then run __SACG.dump() (or click the badge).');
})();

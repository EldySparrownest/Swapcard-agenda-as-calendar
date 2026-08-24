// ==UserScript==
// @name         Swapcard Agenda Calendar Grid
// @namespace    https://github.com/EldySparrownest/Swapcard-agenda-as-calendar
// @version      1.2.0
// @description  The whole Swapcard agenda on one time axis: concurrent sessions side by side, your own picks pinned left, speakers on every block. Read-only.
// @author       Sparrownest
// @match        https://app.swapcard.com/*
// @match        https://*.swapcard.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * HOW IT GETS ITS DATA
 * --------------------
 * Swapcard's agenda is served by two persisted GraphQL operations on /api/graphql:
 *
 *   EventPlanningListViewNavigationQuery  {viewId, timezone}
 *       -> view.navigation[] = one entry per event day, each with an `aggregationId`
 *
 *   PlanningListViewConnectionQuery       {eventId, viewId, timezone, aggregationsIds, after, first}
 *       -> view.plannings.nodes[] = the sessions of that day, including
 *          withEvent.bookmark.isBookmarked -- i.e. "this one is already on my schedule"
 *
 * Both are Automatic Persisted Queries: the client sends only a sha256Hash, never a query
 * document. That hash changes whenever Swapcard ships a new bundle, so this script NEVER
 * hardcodes it. It taps `fetch`, learns the endpoint, the auth header and the current hash
 * from Swapcard's own traffic, and then replays the same operation for the days it has not
 * seen yet. If a replay fails for any reason it degrades to pure passive harvesting: click
 * through the day tabs yourself and the calendar fills in.
 *
 * Sessions are cached in localStorage per event+view, so the calendar survives a reload.
 *
 * READ-ONLY. The script never issues a mutation and never alters a request or a response.
 * Adding a session to your schedule still happens through Swapcard's own UI.
 */

(function () {
  'use strict';

  var LS_PREFIX = 'sacg:v1:';
  var OP_LIST = 'PlanningListViewConnectionQuery';
  var OP_NAV = 'EventPlanningListViewNavigationQuery';
  var OP_BOOKMARKS = 'EventPlanningListViewBookmarkedPlannings';
  var PAGE_SIZE = 50;

  // Where the launcher sits: top-right, clear of Swapcard's header and profile picture, and
  // clear of the live-interaction button and the recon badge in the bottom-right corner.
  // If a future Swapcard header changes height, these two values are the whole fix.
  var BUTTON_TOP = '68px';
  var BUTTON_RIGHT = '14px';
  var MAX_PAGES = 20; // paranoia bound on the pagination loop

  // ------------------------------------------------------------------ helpers

  // Swapcard renders timestamps in the *event's* timezone and hands us the offset
  // ("2026-09-18T09:30:00+02:00"). Read the wall clock straight off the string rather
  // than going through Date, so the grid shows event-local time no matter where the
  // viewer is sitting.
  var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

  function parseTime(iso) {
    var m = ISO_RE.exec(String(iso || ''));
    if (!m) return null;
    return {
      date: m[1] + '-' + m[2] + '-' + m[3],
      minutes: parseInt(m[4], 10) * 60 + parseInt(m[5], 10),
      epoch: Date.parse(iso)
    };
  }

  function speakerName(s) {
    if (!s) return '';
    return [s.firstName, s.lastName].filter(Boolean).join(' ').trim();
  }

  // htmlDescription is event-authored HTML. We never inject it; we flatten it to text.
  function htmlToText(html) {
    if (!html) return '';
    return String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(mins) { return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60); }

  function dayLabel(date) {
    var d = new Date(date + 'T12:00:00Z');
    if (isNaN(d.getTime())) return date;
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()];
  }

  // -------------------------------------------------------------- normalizing

  // Turn one Core_Planning node into the flat shape the grid draws from.
  function normalizeNode(node) {
    if (!node || !node.id) return null;
    var b = parseTime(node.beginsAt);
    var e = parseTime(node.endsAt);
    if (!b || !e) return null;

    var we = node.withEvent || {};
    var bookmark = we.bookmark || {};
    // A session that ends past midnight still belongs to the day it started on.
    var endMinutes = e.date === b.date ? e.minutes : e.minutes + 24 * 60 * Math.max(1, daysBetween(b.date, e.date));

    return {
      id: node.id,
      title: we.title || node.type || '(untitled)',
      day: b.date,
      startMin: b.minutes,
      endMin: Math.max(endMinutes, b.minutes + 5), // never zero-height
      beginsAt: node.beginsAt,
      endsAt: node.endsAt,
      type: node.type || '',
      place: node.place || '',
      format: node.format || '',
      mine: !!bookmark.isBookmarked,
      speakers: (we.firstSpeakers || []).map(function (s) {
        return { name: speakerName(s), org: s.organization || '' };
      }).filter(function (s) { return s.name; }),
      categories: (node.categories || []).map(function (c) { return c && c.name; }).filter(Boolean),
      maxSeats: node.maxSeats,
      remainingSeats: node.remainingSeats,
      description: htmlToText(node.htmlDescription)
    };
  }

  function daysBetween(a, b) {
    var da = Date.parse(a + 'T00:00:00Z'), db = Date.parse(b + 'T00:00:00Z');
    if (isNaN(da) || isNaN(db)) return 1;
    return Math.round((db - da) / 86400000);
  }

  // Pull sessions out of whatever shape the response came back in (single or batched).
  function normalizeConnection(payload) {
    var out = [];
    var entries = Array.isArray(payload) ? payload : [payload];
    entries.forEach(function (entry) {
      var view = entry && entry.data && entry.data.view;
      var conn = view && view.plannings;
      var nodes = (conn && conn.nodes) || [];
      nodes.forEach(function (n) {
        var s = normalizeNode(n);
        if (s) out.push(s);
      });
    });
    return out;
  }

  // page info of the first entry that has one (for the replay pagination loop)
  function pageInfoOf(payload) {
    var entries = Array.isArray(payload) ? payload : [payload];
    for (var i = 0; i < entries.length; i++) {
      var v = entries[i] && entries[i].data && entries[i].data.view;
      if (v && v.plannings && v.plannings.pageInfo) return v.plannings.pageInfo;
    }
    return null;
  }

  function navigationOf(payload) {
    var entries = Array.isArray(payload) ? payload : [payload];
    for (var i = 0; i < entries.length; i++) {
      var v = entries[i] && entries[i].data && entries[i].data.view;
      if (v && Array.isArray(v.navigation)) {
        return v.navigation.map(function (n) {
          return {
            aggregationId: n.aggregationId,
            date: (n.value && n.value.date) ? String(n.value.date).slice(0, 10) : null
          };
        }).filter(function (n) { return n.aggregationId; });
      }
    }
    return null;
  }

  // The bookmarked-sessions operation returns data.agenda[] -- ids only is all we need.
  function bookmarkIdsOf(payload) {
    var entries = Array.isArray(payload) ? payload : [payload];
    for (var i = 0; i < entries.length; i++) {
      var agenda = entries[i] && entries[i].data && entries[i].data.agenda;
      if (Array.isArray(agenda)) {
        return agenda.map(function (a) { return a && a.id; }).filter(Boolean);
      }
    }
    return null;
  }

  // ------------------------------------------------------------ lane packing

  // Concurrent sessions sit side by side. **Lane 0 is reserved for your own picks**, so
  // "what would I give up?" is answerable by looking left. On a day where you have picked
  // nothing there is nothing to reserve it for, and everything starts at lane 0 instead.
  function packLanes(sessions) {
    var mine = [], rest = [];
    sessions.forEach(function (s) {
      s.lane = 0;
      s.conflict = false;
      (s.mine ? mine : rest).push(s);
    });
    var byStart = function (a, b) {
      return a.startMin - b.startMin || a.endMin - b.endMin || (a.title < b.title ? -1 : 1);
    };
    mine.sort(byStart);
    rest.sort(byStart);

    var lanes = []; // lanes[i] = array of placed sessions
    function place(s, floor) {
      for (var i = floor; i < lanes.length; i++) {
        var clash = lanes[i].some(function (o) {
          return s.startMin < o.endMin && o.startMin < s.endMin;
        });
        if (!clash) { lanes[i].push(s); s.lane = i; return; }
      }
      while (lanes.length < floor) lanes.push([]);
      lanes.push([s]);
      s.lane = lanes.length - 1;
    }

    mine.forEach(function (s) { place(s, 0); });
    rest.forEach(function (s) { place(s, mine.length ? 1 : 0); });

    // Double-booked picks: the earlier one keeps lane 0, the later is flagged rather than
    // silently buried, and the day gets a banner naming the clash.
    var clashes = [];
    for (var i = 0; i < mine.length; i++) {
      for (var j = i + 1; j < mine.length; j++) {
        if (mine[i].startMin < mine[j].endMin && mine[j].startMin < mine[i].endMin) {
          mine[j].conflict = true;
          clashes.push([mine[i], mine[j]]);
        }
      }
    }

    return {
      lanes: Math.max(1, lanes.length),
      sessions: sessions.slice().sort(byStart),
      clashes: clashes
    };
  }

  function layout(sessions) {
    var byDay = {};
    sessions.forEach(function (s) { (byDay[s.day] = byDay[s.day] || []).push(s); });
    return Object.keys(byDay).sort().map(function (day) {
      var packed = packLanes(byDay[day]);
      var min = Infinity, max = -Infinity;
      packed.sessions.forEach(function (s) {
        if (s.startMin < min) min = s.startMin;
        if (s.endMin > max) max = s.endMin;
      });
      return {
        day: day,
        label: dayLabel(day),
        lanes: packed.lanes,
        sessions: packed.sessions,
        clashes: packed.clashes,
        fromMin: Math.floor(min / 60) * 60,
        toMin: Math.ceil(max / 60) * 60,
        mineCount: packed.sessions.filter(function (s) { return s.mine; }).length
      };
    });
  }

  // -------------------------------------------------------------------- store

  var store = {
    key: null,
    sessions: {},   // id -> session
    days: [],       // [{aggregationId, date}]

    setKey: function (eventId, viewId) {
      var k = LS_PREFIX + (eventId || '?') + ':' + (viewId || '?');
      if (this.key === k) return;
      this.key = k;
      this.load();
    },
    load: function () {
      try {
        var raw = window.localStorage.getItem(this.key);
        if (!raw) return;
        var parsed = JSON.parse(raw);
        this.sessions = parsed.sessions || {};
        this.days = parsed.days || [];
      } catch (err) { /* corrupt or unavailable storage is not fatal */ }
    },
    save: function () {
      if (!this.key) return;
      try {
        window.localStorage.setItem(this.key, JSON.stringify({
          savedAt: new Date().toISOString(),
          sessions: this.sessions,
          days: this.days
        }));
      } catch (err) { /* quota or private mode -- keep running from memory */ }
    },
    ingest: function (sessions) {
      var added = 0;
      var self = this;
      sessions.forEach(function (s) {
        if (!self.sessions[s.id]) added++;
        self.sessions[s.id] = s;
      });
      if (sessions.length) this.save();
      return added;
    },
    setDays: function (days) {
      if (!days || !days.length) return;
      this.days = days;
      this.save();
    },
    // Authoritative bookmark list wins over whatever the cached nodes said.
    applyBookmarks: function (ids) {
      if (!ids) return;
      var set = {};
      ids.forEach(function (id) { set[id] = true; });
      var self = this;
      Object.keys(this.sessions).forEach(function (id) {
        self.sessions[id].mine = !!set[id];
      });
      this.save();
    },
    all: function () {
      var self = this;
      return Object.keys(this.sessions).map(function (id) { return self.sessions[id]; });
    },
    daysSeen: function () {
      var seen = {};
      this.all().forEach(function (s) { seen[s.day] = true; });
      return seen;
    }
  };

  // ------------------------------------------------------- learned API template

  // Everything needed to replay an operation, harvested from Swapcard's own requests.
  var api = {
    endpoint: null,
    headers: null,
    hashes: {},      // operationName -> sha256Hash
    variables: {},   // operationName -> last seen variables
    ready: function (op) {
      return !!(this.endpoint && this.headers && this.hashes[op] && this.variables[op]);
    }
  };

  var COPY_HEADERS = /^(accept|content-type|authorization|x-client-version|x-client-platform|x-client-origin|x-feature-flags|apollographql-client-name|apollographql-client-version)$/i;

  function learn(url, headers, body) {
    if (!Array.isArray(body) && !(body && body.operationName)) return;
    var entries = Array.isArray(body) ? body : [body];
    var useful = false;

    entries.forEach(function (e) {
      var op = e && e.operationName;
      if (!op) return;
      var hash = e.extensions && e.extensions.persistedQuery && e.extensions.persistedQuery.sha256Hash;
      if (hash) api.hashes[op] = hash;
      if (e.variables) api.variables[op] = e.variables;
      if (op === OP_LIST || op === OP_NAV || op === OP_BOOKMARKS) useful = true;
    });

    if (!useful) return;
    api.endpoint = url;
    var copied = {};
    Object.keys(headers || {}).forEach(function (h) {
      if (COPY_HEADERS.test(h)) copied[h] = headers[h];
    });
    copied['content-type'] = 'application/json';
    api.headers = copied;
  }

  // ------------------------------------------------------------ the fetch tap

  var origFetch = window.fetch;
  var origOpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
  var origSend = window.XMLHttpRequest && window.XMLHttpRequest.prototype.send;
  var origSetHeader = window.XMLHttpRequest && window.XMLHttpRequest.prototype.setRequestHeader;

  function looksLikeGraphQL(url) {
    return typeof url === 'string' && url.indexOf('graphql') !== -1;
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (err) { return null; }
  }

  // The single place every observed or replayed payload flows through.
  function ingestPayload(payload) {
    if (!payload) return;

    var sessions = normalizeConnection(payload);
    if (sessions.length) {
      store.ingest(sessions);
      scheduleRepaint();
    }

    var nav = navigationOf(payload);
    if (nav) {
      store.setDays(nav);
      maybePrefetch();
    }

    var bm = bookmarkIdsOf(payload);
    if (bm) {
      store.applyBookmarks(bm);
      scheduleRepaint();
    }
  }

  function headersToObject(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) {
      try { h.forEach(function (v, k) { out[String(k).toLowerCase()] = v; }); return out; } catch (err) { /* fall through */ }
    }
    if (Array.isArray(h)) {
      h.forEach(function (pair) { if (pair && pair.length === 2) out[String(pair[0]).toLowerCase()] = pair[1]; });
      return out;
    }
    Object.keys(h).forEach(function (k) { out[k.toLowerCase()] = h[k]; });
    return out;
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var result = origFetch.apply(this, arguments);

    if (looksLikeGraphQL(url)) {
      try {
        var headers = headersToObject((init && init.headers) || (input && input.headers));
        var body = init && typeof init.body === 'string' ? safeParse(init.body) : null;
        if (body) {
          learn(url, headers, body);
          adoptIdsFrom(body);
        }
      } catch (err) { /* never let the tap break the page */ }

      result.then(function (res) {
        try {
          res.clone().text().then(function (text) {
            ingestPayload(safeParse(text));
          })['catch'](function () {});
        } catch (err) { /* opaque or already-consumed response */ }
      })['catch'](function () {});
    }

    return result;
  };

  if (origOpen) {
    window.XMLHttpRequest.prototype.open = function (method, url) {
      this.__sacgUrl = url;
      this.__sacgHeaders = {};
      return origOpen.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (this.__sacgHeaders) this.__sacgHeaders[String(k).toLowerCase()] = v;
      return origSetHeader.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;
      if (looksLikeGraphQL(xhr.__sacgUrl)) {
        try {
          var parsed = typeof body === 'string' ? safeParse(body) : null;
          if (parsed) { learn(xhr.__sacgUrl, xhr.__sacgHeaders, parsed); adoptIdsFrom(parsed); }
        } catch (err) { /* ignore */ }
        xhr.addEventListener('load', function () {
          try { ingestPayload(safeParse(xhr.responseText)); } catch (err) { /* ignore */ }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  // Any observed request tells us which event/view we are looking at.
  function adoptIdsFrom(body) {
    var entries = Array.isArray(body) ? body : [body];
    entries.forEach(function (e) {
      var v = e && e.variables;
      if (!v) return;
      if (v.eventId || v.viewId) store.setKey(v.eventId, v.viewId);
    });
  }

  // ------------------------------------------------------------------- replay

  function replay(op, variables) {
    if (!api.ready(op)) return Promise.reject(new Error('no template for ' + op));
    var body = [{
      operationName: op,
      variables: variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: api.hashes[op] } }
    }];
    return origFetch.call(window, api.endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: api.headers,
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (payload) {
      var errs = (Array.isArray(payload) ? payload : [payload])
        .map(function (p) { return p && p.errors; })
        .filter(Boolean);
      if (errs.length) {
        // PersistedQueryNotFound means Swapcard redeployed and the learned hash is stale.
        // Nothing to do but wait for the next live request to teach us the new one.
        throw new Error(JSON.stringify(errs[0]).slice(0, 200));
      }
      return payload;
    });
  }

  // Fetch every day of the event that we have not harvested yet.
  function fetchDay(day) {
    var base = api.variables[OP_LIST] || {};
    var vars = {
      eventId: base.eventId,
      withEvent: base.withEvent !== undefined ? base.withEvent : true,
      viewId: base.viewId,
      timezone: base.timezone,
      aggregationsIds: [day.aggregationId],
      after: null,
      first: PAGE_SIZE
    };

    var pages = 0;
    function step(after) {
      vars.after = after;
      return replay(OP_LIST, JSON.parse(JSON.stringify(vars))).then(function (payload) {
        ingestPayload(payload);
        var pi = pageInfoOf(payload);
        pages++;
        if (pi && pi.hasNextPage && pi.endCursor && pages < MAX_PAGES) return step(pi.endCursor);
        return null;
      });
    }
    return step(null);
  }

  var prefetching = false;

  function maybePrefetch() {
    if (prefetching) return Promise.resolve();
    if (!api.ready(OP_LIST) || !store.days.length) return Promise.resolve();

    var seen = store.daysSeen();
    var missing = store.days.filter(function (d) { return !d.date || !seen[d.date]; });
    if (!missing.length) return Promise.resolve();

    prefetching = true;
    setStatus('Fetching ' + missing.length + ' more day' + (missing.length === 1 ? '' : 's') + '…');

    return missing.reduce(function (chain, day) {
      return chain.then(function () { return fetchDay(day); })['catch'](function (err) {
        console.warn('[SACG] could not prefetch a day:', err && err.message);
      });
    }, Promise.resolve()).then(function () {
      prefetching = false;
      setStatus('');
      scheduleRepaint();
    });
  }

  function refreshBookmarks() {
    if (!api.ready(OP_BOOKMARKS)) return Promise.resolve();
    return replay(OP_BOOKMARKS, api.variables[OP_BOOKMARKS])
      .then(ingestPayload)['catch'](function () {});
  }

  // ---------------------------------------------------------------------- UI

  var ui = { button: null, overlay: null, body: null, status: null, activeDay: null, zoom: 1.5, open: false };
  var repaintQueued = false;

  function scheduleRepaint() {
    if (!ui.open || repaintQueued) return;
    repaintQueued = true;
    setTimeout(function () { repaintQueued = false; paint(); }, 120);
  }

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var C = {
    bg: '#12181b', panel: '#1a2226', line: '#2b373d', text: '#e8eef0',
    dim: '#93a4ab', mine: '#2E8A87', mineText: '#eafffd', block: '#243036'
  };

  // Colour-code by activity type. Derived from the string rather than a fixed table of the
  // 15 values this event happens to use, so an event with different types still reads.
  var TYPE_HUE = {};
  function typeHue(type) {
    if (!(type in TYPE_HUE)) {
      var h = 0;
      for (var i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) % 360;
      TYPE_HUE[type] = h;
    }
    return TYPE_HUE[type];
  }
  function typeFill(type) { return type ? 'hsl(' + typeHue(type) + ',22%,20%)' : C.block; }
  function typeEdge(type) { return type ? 'hsl(' + typeHue(type) + ',26%,34%)' : C.line; }

  function setStatus(msg) {
    if (ui.status) ui.status.textContent = msg || '';
  }

  function mountButton() {
    if (ui.button || !document.body) return;
    var b = el('div',
      'position:fixed;z-index:2147483646;top:' + BUTTON_TOP + ';right:' + BUTTON_RIGHT + ';' +
      'background:' + C.mine + ';' +
      'color:#fff;font:600 12px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:6px;' +
      'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);user-select:none',
      'Agenda grid');
    b.id = 'sacg-open';
    b.title = 'Swapcard Agenda Calendar Grid — the whole agenda on one time axis';
    b.addEventListener('click', openOverlay);
    document.body.appendChild(b);
    ui.button = b;
  }

  function openOverlay() {
    if (!ui.overlay) buildOverlay();
    ui.overlay.style.display = 'flex';
    ui.open = true;
    paint();
    maybePrefetch();
    refreshBookmarks().then(scheduleRepaint);
  }

  function closeOverlay() {
    if (ui.overlay) ui.overlay.style.display = 'none';
    ui.open = false;
  }

  function buildOverlay() {
    var o = el('div',
      'position:fixed;inset:0;z-index:2147483647;background:' + C.bg + ';color:' + C.text + ';' +
      'font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;display:flex;flex-direction:column');
    o.id = 'sacg-overlay';

    var head = el('div',
      'display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid ' + C.line + ';flex:0 0 auto;flex-wrap:wrap');

    var title = el('div', 'font-weight:700;letter-spacing:.2px', 'Swapcard Agenda Calendar Grid');
    var tabs = el('div', 'display:flex;gap:6px;flex-wrap:wrap');
    tabs.id = 'sacg-tabs';
    var spacer = el('div', 'flex:1 1 auto');
    var status = el('div', 'color:' + C.dim + ';font-size:12px');
    var zoomOut = btn('−', function () { ui.zoom = Math.max(0.6, ui.zoom - 0.3); paint(); });
    var zoomIn = btn('+', function () { ui.zoom = Math.min(4, ui.zoom + 0.3); paint(); });
    var refresh = btn('Refresh', function () {
      setStatus('Refreshing…');
      refreshBookmarks().then(function () {
        var seen = store.daysSeen();
        Object.keys(seen).forEach(function (d) { delete seen[d]; });
        return maybePrefetch();
      }).then(function () { setStatus(''); paint(); });
    });
    var close = btn('Close (Esc)', closeOverlay);

    head.appendChild(title);
    head.appendChild(tabs);
    head.appendChild(spacer);
    head.appendChild(status);
    head.appendChild(zoomOut);
    head.appendChild(zoomIn);
    head.appendChild(refresh);
    head.appendChild(close);

    var body = el('div', 'flex:1 1 auto;overflow:auto;padding:0 14px 40px');

    o.appendChild(head);
    o.appendChild(body);
    document.body.appendChild(o);

    ui.overlay = o; ui.body = body; ui.status = status; ui.tabs = tabs;

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ui.open) closeOverlay();
    });
  }

  function btn(label, onClick) {
    var b = el('button',
      'background:' + C.panel + ';color:' + C.text + ';border:1px solid ' + C.line + ';' +
      'border-radius:5px;padding:4px 10px;cursor:pointer;font:inherit', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function tab(label, active, onClick) {
    var t = el('button',
      'background:' + (active ? C.mine : C.panel) + ';color:' + (active ? '#fff' : C.dim) + ';' +
      'border:1px solid ' + (active ? C.mine : C.line) + ';border-radius:5px;padding:4px 10px;' +
      'cursor:pointer;font:inherit', label);
    t.addEventListener('click', onClick);
    return t;
  }

  // Today if the event is running, otherwise its first day -- one day at a time.
  function defaultDay(days) {
    var today = new Date();
    var iso = today.getFullYear() + '-' + pad2(today.getMonth() + 1) + '-' + pad2(today.getDate());
    for (var i = 0; i < days.length; i++) if (days[i].day === iso) return days[i].day;
    return days[0].day;
  }

  function paint() {
    if (!ui.overlay) return;
    var days = layout(store.all());
    if (ui.activeDay === null && days.length) ui.activeDay = defaultDay(days);

    // ---- day tabs
    ui.tabs.textContent = '';
    if (days.length > 1) {
      ui.tabs.appendChild(tab('All days', ui.activeDay === 'ALL', function () { ui.activeDay = 'ALL'; paint(); }));
    }
    days.forEach(function (d) {
      var label = d.label + (d.mineCount ? ' ·' + d.mineCount : '');
      ui.tabs.appendChild(tab(label, ui.activeDay === d.day, function () { ui.activeDay = d.day; paint(); }));
    });

    // ---- body
    ui.body.textContent = '';

    if (!days.length) {
      ui.body.appendChild(emptyState());
      return;
    }

    var shown = ui.activeDay === 'ALL' ? days : days.filter(function (d) { return d.day === ui.activeDay; });
    if (!shown.length) { ui.activeDay = 'ALL'; shown = days; }

    shown.forEach(function (d) { ui.body.appendChild(renderDay(d)); });

    var total = store.all().length;
    var mine = store.all().filter(function (s) { return s.mine; }).length;
    ui.body.appendChild(el('div', 'color:' + C.dim + ';font-size:12px;padding:14px 0 0',
      total + ' sessions across ' + days.length + ' day' + (days.length === 1 ? '' : 's') +
      ' · ' + mine + ' on your schedule · read-only, add sessions in Swapcard itself'));
  }

  function emptyState() {
    var wrap = el('div', 'padding:40px 0;max-width:620px');
    wrap.appendChild(el('div', 'font-size:15px;font-weight:600;margin-bottom:8px', 'No sessions captured yet'));
    wrap.appendChild(el('div', 'color:' + C.dim,
      'Open the event agenda (Plannings) once and this fills in automatically. If it stays empty, ' +
      'the page may not have loaded the agenda query yet — reload the agenda page and reopen this.'));
    return wrap;
  }

  function renderDay(d) {
    var PX = ui.zoom; // px per minute
    var span = d.toMin - d.fromMin;
    var height = Math.max(200, span * PX);
    var GUTTER = 56;

    var section = el('div', 'padding:18px 0 6px');
    section.appendChild(el('div', 'font-weight:700;font-size:14px;margin-bottom:8px',
      d.label + '  ' + hhmm(d.fromMin) + '–' + hhmm(Math.min(d.toMin, 24 * 60 - 1))));

    // Double-booked picks are called out rather than silently stacked.
    if (d.clashes && d.clashes.length) {
      var banner = el('div',
        'background:#3a2a12;border:1px solid #7a5a22;border-radius:6px;padding:8px 10px;' +
        'margin-bottom:10px;font-size:12px');
      banner.appendChild(el('div', 'font-weight:600;margin-bottom:3px',
        d.clashes.length + ' clash' + (d.clashes.length === 1 ? '' : 'es') + ' on your schedule'));
      d.clashes.forEach(function (pair) {
        banner.appendChild(el('div', 'opacity:.9',
          hhmm(pair[0].startMin) + ' ' + pair[0].title + '  ✕  ' +
          hhmm(pair[1].startMin) + ' ' + pair[1].title));
      });
      section.appendChild(banner);
    }

    var grid = el('div', 'position:relative;height:' + height + 'px;margin-left:' + GUTTER + 'px;' +
      'border-left:1px solid ' + C.line);

    // hour rules + labels
    for (var m = d.fromMin; m <= d.toMin; m += 60) {
      var y = (m - d.fromMin) * PX;
      var rule = el('div', 'position:absolute;left:0;right:0;top:' + y + 'px;height:1px;background:' + C.line + ';opacity:.6');
      grid.appendChild(rule);
      var lab = el('div', 'position:absolute;left:-' + GUTTER + 'px;top:' + (y - 7) + 'px;width:' +
        (GUTTER - 8) + 'px;text-align:right;color:' + C.dim + ';font-size:11px', hhmm(m % (24 * 60)));
      grid.appendChild(lab);
    }

    var laneCount = Math.max(1, d.lanes);
    d.sessions.forEach(function (s) {
      grid.appendChild(renderBlock(s, d, laneCount, PX));
    });

    section.appendChild(grid);
    return section;
  }

  function renderBlock(s, d, laneCount, PX) {
    var top = (s.startMin - d.fromMin) * PX;
    var h = Math.max(22, (s.endMin - s.startMin) * PX - 2);
    var w = 100 / laneCount;
    var left = s.lane * w;

    var block = el('div',
      'position:absolute;top:' + top + 'px;left:calc(' + left + '% + 3px);width:calc(' + w + '% - 6px);' +
      'height:' + h + 'px;overflow:hidden;border-radius:5px;padding:4px 6px;box-sizing:border-box;' +
      'cursor:pointer;font-size:11.5px;line-height:1.3;' +
      (s.mine
        ? 'background:' + C.mine + ';color:' + C.mineText + ';border:1px solid ' +
          (s.conflict ? '#e0a33a;box-shadow:inset 0 0 0 1px #e0a33a' : '#3fb3af')
        : 'background:' + typeFill(s.type) + ';color:' + C.text + ';border:1px solid ' + typeEdge(s.type)));

    var stamp = hhmm(s.startMin) + '–' + hhmm(s.endMin % (24 * 60)) + (s.type ? ' · ' + s.type : '');
    block.appendChild(el('div', 'opacity:.75;font-size:10.5px', stamp));

    block.appendChild(el('div', 'font-weight:600;margin:1px 0',
      (s.conflict ? '⚠ ' : '') + s.title));

    if (h > 44 && s.speakers.length) {
      block.appendChild(el('div', 'opacity:.85;font-size:10.5px',
        s.speakers.map(function (x) { return x.name; }).join(', ')));
    }
    if (h > 62 && s.place) {
      block.appendChild(el('div', 'opacity:.65;font-size:10.5px', s.place));
    }
    if (h > 80 && s.remainingSeats !== null && s.remainingSeats !== undefined) {
      block.appendChild(el('div', 'opacity:.65;font-size:10.5px',
        s.remainingSeats + ' of ' + s.maxSeats + ' seats left'));
    }

    block.title = detailText(s);
    block.addEventListener('click', function () { showDetail(s); });
    return block;
  }

  function detailText(s) {
    var bits = [hhmm(s.startMin) + '–' + hhmm(s.endMin % (24 * 60)), s.title];
    if (s.type) bits.push(s.type);
    if (s.place) bits.push(s.place);
    if (s.speakers.length) {
      bits.push(s.speakers.map(function (x) {
        return x.name + (x.org ? ' (' + x.org + ')' : '');
      }).join('\n'));
    }
    if (s.mine) bits.push('★ on your schedule');
    return bits.join('\n');
  }

  function showDetail(s) {
    var scrim = el('div',
      'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;' +
      'align-items:center;justify-content:center;padding:24px');
    var card = el('div',
      'background:' + C.panel + ';border:1px solid ' + C.line + ';border-radius:8px;max-width:640px;' +
      'width:100%;max-height:80vh;overflow:auto;padding:18px 20px');

    card.appendChild(el('div', 'color:' + C.dim + ';font-size:12px',
      dayLabel(s.day) + ' · ' + hhmm(s.startMin) + '–' + hhmm(s.endMin % (24 * 60)) +
      (s.type ? ' · ' + s.type : '') + (s.mine ? ' · ★ on your schedule' : '')));
    card.appendChild(el('div', 'font-size:17px;font-weight:700;margin:6px 0 10px', s.title));

    if (s.place) card.appendChild(el('div', 'margin-bottom:6px', s.place));
    if (s.format) card.appendChild(el('div', 'color:' + C.dim + ';font-size:12px;margin-bottom:6px', s.format));

    if (s.speakers.length) {
      var sp = el('div', 'margin:10px 0');
      sp.appendChild(el('div', 'font-weight:600;margin-bottom:4px', 'Speakers'));
      s.speakers.forEach(function (x) {
        sp.appendChild(el('div', 'color:' + C.text, x.name + (x.org ? ' — ' + x.org : '')));
      });
      card.appendChild(sp);
    }

    if (s.categories.length) {
      card.appendChild(el('div', 'color:' + C.dim + ';font-size:12px;margin:8px 0', s.categories.join(' · ')));
    }
    if (s.remainingSeats !== null && s.remainingSeats !== undefined) {
      card.appendChild(el('div', 'color:' + C.dim + ';font-size:12px', s.remainingSeats + ' of ' + s.maxSeats + ' seats left'));
    }
    if (s.description) {
      card.appendChild(el('div', 'margin-top:12px;white-space:pre-wrap', s.description));
    }

    var row = el('div', 'display:flex;gap:8px;margin-top:16px');
    var link = sessionUrl(s.id);
    if (link) {
      var a = el('a', 'background:' + C.mine + ';color:#fff;text-decoration:none;border-radius:5px;padding:6px 12px', 'Open in Swapcard');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener';
      row.appendChild(a);
    }
    row.appendChild(btn('Close', function () { scrim.remove(); }));
    card.appendChild(row);

    scrim.addEventListener('click', function (e) { if (e.target === scrim) scrim.remove(); });
    scrim.appendChild(card);
    document.body.appendChild(scrim);
  }

  // https://app.swapcard.com/event/<slug>/planning/<planningId>
  function sessionUrl(id) {
    var m = /\/event\/([^/]+)/.exec(window.location.pathname || '');
    if (!m) return null;
    return window.location.origin + '/event/' + m[1] + '/planning/' + id;
  }

  // -------------------------------------------------------------------- boot

  function boot() {
    try { mountButton(); } catch (err) { console.warn('[SACG] could not mount button:', err); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Swapcard is an SPA; the button survives client-side navigation, but re-assert it
  // in case a route swap wipes body children.
  setInterval(function () {
    if (!document.body) return;
    if (ui.button && !document.body.contains(ui.button)) { ui.button = null; }
    if (!ui.button) { try { mountButton(); } catch (err) { /* ignore */ } }
  }, 4000);

  // ---------------------------------------------------------------- test seam

  var exposed = {
    parseTime: parseTime,
    speakerName: speakerName,
    htmlToText: htmlToText,
    normalizeNode: normalizeNode,
    normalizeConnection: normalizeConnection,
    navigationOf: navigationOf,
    bookmarkIdsOf: bookmarkIdsOf,
    pageInfoOf: pageInfoOf,
    packLanes: packLanes,
    layout: layout,
    store: store,
    api: api,
    open: openOverlay,
    close: closeOverlay
  };

  window.__SACG_CAL = exposed;
  if (typeof module !== 'undefined' && module.exports) module.exports = exposed;

  console.log('[SACG] Swapcard Agenda Calendar Grid armed. Open the agenda, then click "Agenda grid" top-right.');
})();

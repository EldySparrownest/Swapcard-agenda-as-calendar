// Stubbed-browser tests for swapcard-agenda-calendar-grid.user.js.
//
// Everything here exercises the pure core (parsing, lane packing, the fetch tap) without a
// real DOM. If the recon capture is present it is also replayed through the parser as a
// fixture -- that file is gitignored, so those checks skip when it is absent.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'swapcard-agenda-calendar-grid.user.js');

// --- a DOM stub thin enough to boot the script -------------------------------
function makeNode(tag) {
  const node = {
    tag,
    id: '',
    title: '',
    children: [],
    style: {},
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    addEventListener() {},
    contains() { return true; }
  };
  return node;
}

const documentStub = {
  readyState: 'complete',
  body: makeNode('body'),
  addEventListener() {},
  createElement: makeNode
};

const storage = new Map();

const sandbox = {
  console: { log() {}, warn() {}, error: console.error },
  setTimeout,
  clearTimeout,
  setInterval() { return 0; }, // the SPA re-mount poll would keep node alive
  clearInterval() {},
  Promise, JSON, Date, Object, Array, String, Number, Math, Error, RegExp, isNaN, parseInt, Infinity,
  document: documentStub,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k)
  },
  XMLHttpRequest: function () {}
};

sandbox.window = sandbox;
sandbox.location = {
  href: 'https://app.swapcard.com/event/care-conference-2026/plannings/RXZ=',
  origin: 'https://app.swapcard.com',
  pathname: '/event/care-conference-2026/plannings/RXZ='
};
sandbox.XMLHttpRequest.prototype = {
  open() {}, send() {}, setRequestHeader() {}, addEventListener() {}
};

// original fetch: hands back a canned agenda response
const cannedResponse = [{
  data: {
    view: {
      id: 'RXZlbnRWaWV3XzE=',
      plannings: {
        nodes: [{
          id: 'UGxhbm5pbmdfMQ==',
          beginsAt: '2026-09-18T09:30:00+02:00',
          endsAt: '2026-09-18T10:00:00+02:00',
          type: 'Talk',
          place: 'Yellow stairs',
          htmlDescription: '<p>Hello <b>there</b></p>',
          format: 'LIVE_STREAM',
          categories: [{ id: 'c1', name: 'Research' }],
          maxSeats: null,
          remainingSeats: null,
          withEvent: {
            title: 'Opening Talk',
            firstSpeakers: [{ id: 's1', firstName: 'Ada', lastName: 'Lovelace', organization: 'AI' }],
            bookmark: { isBookmarked: true, canBookmark: true }
          }
        }],
        pageInfo: { hasNextPage: false, endCursor: 'CUR' },
        totalCount: 1
      }
    }
  }
}];

let originalFetchCalls = 0;
const sentinelResponse = {
  ok: true,
  status: 200,
  clone() { return { text: () => Promise.resolve(JSON.stringify(cannedResponse)) }; },
  json() { return Promise.resolve(cannedResponse); }
};
sandbox.fetch = function () {
  originalFetchCalls++;
  return Promise.resolve(sentinelResponse);
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox);

const SACG = sandbox.window.__SACG_CAL;

// --- tiny assert harness -----------------------------------------------------
let failed = 0;
let skipped = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}
function skip(name, why) { skipped++; console.log('  SKIP  ' + name + '  -- ' + why); }

// --- 1. time parsing ---------------------------------------------------------
const t = SACG.parseTime('2026-09-18T09:30:00+02:00');
check('parseTime reads the event-local wall clock', t.date === '2026-09-18' && t.minutes === 570,
  JSON.stringify(t));
check('parseTime rejects junk', SACG.parseTime('not a date') === null);

// --- 2. text flattening ------------------------------------------------------
check('htmlToText strips markup', SACG.htmlToText('<p>Hi <b>you</b></p>') === 'Hi you',
  JSON.stringify(SACG.htmlToText('<p>Hi <b>you</b></p>')));
check('htmlToText decodes entities', SACG.htmlToText('a &amp; b &#39;c&#39;') === "a & b 'c'");

// --- 3. node normalizing -----------------------------------------------------
const sessions = SACG.normalizeConnection(cannedResponse);
check('normalizeConnection found the session', sessions.length === 1);
const s0 = sessions[0];
check('title comes from withEvent.title', s0.title === 'Opening Talk');
check('bookmark maps to `mine`', s0.mine === true);
check('speakers flattened to name + org',
  s0.speakers.length === 1 && s0.speakers[0].name === 'Ada Lovelace' && s0.speakers[0].org === 'AI',
  JSON.stringify(s0.speakers));
check('description flattened to text', s0.description === 'Hello there', JSON.stringify(s0.description));
check('categories kept by name', s0.categories.join() === 'Research');

// a session running past midnight must stay on its starting day, with end > start
const overnight = SACG.normalizeNode({
  id: 'X', beginsAt: '2026-09-17T20:00:00+02:00', endsAt: '2026-09-18T01:30:00+02:00',
  withEvent: { title: 'Afterparty', firstSpeakers: [], bookmark: {} }
});
check('past-midnight session stays on its start day', overnight.day === '2026-09-17');
check('past-midnight session has end after start',
  overnight.endMin > overnight.startMin && overnight.endMin === 25 * 60 + 30,
  'endMin=' + overnight.endMin);

// --- 4. sibling operations ---------------------------------------------------
check('navigationOf pulls the day list', (() => {
  const nav = SACG.navigationOf([{ data: { view: { navigation: [
    { aggregationId: 'AAA', value: { date: '2026-09-17T00:00:00+02:00' } },
    { aggregationId: 'BBB', value: { date: '2026-09-18T00:00:00+02:00' } }
  ] } } }]);
  return nav.length === 2 && nav[0].date === '2026-09-17' && nav[1].aggregationId === 'BBB';
})());
check('bookmarkIdsOf pulls the agenda ids', (() => {
  const ids = SACG.bookmarkIdsOf([{ data: { agenda: [{ id: 'a' }, { id: 'b' }] } }]);
  return ids.join() === 'a,b';
})());
check('pageInfoOf finds the cursor', SACG.pageInfoOf(cannedResponse).endCursor === 'CUR');

// --- 5. lane packing ---------------------------------------------------------
function fake(id, start, end, mine) {
  return { id, title: id, day: '2026-09-18', startMin: start, endMin: end, mine: !!mine, speakers: [] };
}

// three overlapping sessions -> three lanes; the bookmarked one takes lane 0
let packed = SACG.packLanes([
  fake('a', 600, 660, false),
  fake('b', 600, 660, false),
  fake('mine', 600, 660, true)
]);
check('overlapping sessions get their own lanes', packed.lanes === 3, 'lanes=' + packed.lanes);
check('your pick is pinned to the leftmost lane',
  packed.sessions.find((x) => x.id === 'mine').lane === 0,
  JSON.stringify(packed.sessions.map((x) => [x.id, x.lane])));

// non-overlapping sessions share a lane
packed = SACG.packLanes([fake('a', 600, 660, false), fake('b', 660, 720, false)]);
check('back-to-back sessions share one lane', packed.lanes === 1, 'lanes=' + packed.lanes);

// lane 0 stays reserved for your picks even at times when none of them is running
packed = SACG.packLanes([
  fake('mine', 600, 660, true),
  fake('later', 700, 760, false)
]);
check('lane 0 stays reserved for your picks all day',
  packed.sessions.find((x) => x.id === 'later').lane === 1,
  JSON.stringify(packed.sessions.map((x) => [x.id, x.lane])));

// ...but a day where you picked nothing has nothing to reserve it for
packed = SACG.packLanes([fake('a', 600, 660, false), fake('b', 700, 760, false)]);
check('a day with no picks starts at lane 0',
  packed.lanes === 1 && packed.sessions.every((x) => x.lane === 0),
  JSON.stringify(packed.sessions.map((x) => [x.id, x.lane])));

// two of your own picks that clash both stay left of everything else
packed = SACG.packLanes([
  fake('other', 600, 660, false),
  fake('mine1', 600, 660, true),
  fake('mine2', 600, 660, true)
]);
const laneOf = (id) => packed.sessions.find((x) => x.id === id).lane;
check('double-booked picks take the two leftmost lanes',
  laneOf('mine1') < laneOf('other') && laneOf('mine2') < laneOf('other'),
  JSON.stringify(packed.sessions.map((x) => [x.id, x.lane])));
check('the earlier of two clashing picks keeps lane 0', laneOf('mine1') === 0);
check('the clash is reported once', packed.clashes.length === 1,
  'clashes=' + packed.clashes.length);
check('the later clashing pick is flagged, the earlier is not',
  packed.sessions.find((x) => x.id === 'mine2').conflict === true &&
  packed.sessions.find((x) => x.id === 'mine1').conflict === false);
check('sessions that merely touch are not a clash',
  SACG.packLanes([fake('m1', 600, 660, true), fake('m2', 660, 720, true)]).clashes.length === 0);

// --- 6. day layout -----------------------------------------------------------
const days = SACG.layout([
  fake('d1', 600, 660, true),
  Object.assign(fake('d2', 540, 600, false), { day: '2026-09-19' })
]);
check('layout splits by day and sorts', days.length === 2 && days[0].day === '2026-09-18');
check('layout snaps the axis to whole hours', days[0].fromMin === 600 && days[0].toMin === 660);
check('layout counts your picks per day', days[0].mineCount === 1 && days[1].mineCount === 0);

// --- 7. the fetch tap --------------------------------------------------------
const before = originalFetchCalls;
const returned = sandbox.window.fetch('https://app.swapcard.com/api/graphql', {
  method: 'POST',
  headers: { authorization: 'Bearer xyz', 'x-client-version': '2.310.174', 'content-type': 'application/json' },
  body: JSON.stringify([{
    operationName: 'PlanningListViewConnectionQuery',
    variables: { eventId: 'E1', viewId: 'V1', timezone: 'Europe/Warsaw', aggregationsIds: ['AGG'], first: 50 },
    extensions: { persistedQuery: { version: 1, sha256Hash: 'HASH123' } }
  }])
});

check('tap calls through to the original fetch exactly once', originalFetchCalls === before + 1);

returned.then((res) => {
  check('tap returns the untouched response object', res === sentinelResponse);

  // give the async clone().text() chain a tick to land
  setTimeout(() => {
    check('tap learned the persisted-query hash', SACG.api.hashes.PlanningListViewConnectionQuery === 'HASH123',
      JSON.stringify(SACG.api.hashes));
    check('tap learned the auth header for replay',
      SACG.api.headers && SACG.api.headers.authorization === 'Bearer xyz',
      JSON.stringify(SACG.api.headers));
    check('tap learned the variables template',
      SACG.api.variables.PlanningListViewConnectionQuery.eventId === 'E1');
    check('tap is ready to replay', SACG.api.ready('PlanningListViewConnectionQuery') === true);
    check('harvested response reached the store',
      SACG.store.all().some((x) => x.id === 'UGxhbm5pbmdfMQ=='),
      JSON.stringify(SACG.store.all().map((x) => x.id)));
    check('store persisted to localStorage', storage.size > 0);

    // --- 8. authoritative bookmark list overrides cached flags ---------------
    SACG.store.applyBookmarks([]);
    check('an empty bookmark list clears stale picks',
      SACG.store.all().every((x) => x.mine === false));
    SACG.store.applyBookmarks(['UGxhbm5pbmdfMQ==']);
    check('the bookmark list re-marks your picks',
      SACG.store.all().find((x) => x.id === 'UGxhbm5pbmdfMQ==').mine === true);

    runFixture();
    finish();
  }, 20);
});

// --- 9. the real capture, if it is here --------------------------------------
function runFixture() {
  const dir = path.join(ROOT, 'recon');
  const hits = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^swapcard-recon-.*\.json$/.test(f))
    : [];
  if (!hits.length) {
    skip('real capture parses to a complete agenda', 'no recon/swapcard-recon-*.json (gitignored)');
    return;
  }

  const capture = JSON.parse(fs.readFileSync(path.join(dir, hits[0]), 'utf8'));
  const all = {};
  let navDays = null;
  capture.calls.forEach((call) => {
    const body = call.responseBody;
    if (!body) return;
    SACG.normalizeConnection(body).forEach((s) => { all[s.id] = s; });
    const nav = SACG.navigationOf(body);
    if (nav) navDays = nav;
  });

  const list = Object.keys(all).map((k) => all[k]);
  check('real capture yields sessions', list.length > 0, 'count=' + list.length);
  check('every real session has a title and a positive duration',
    list.every((s) => s.title && s.endMin > s.startMin));
  check('every real session parsed a day',
    list.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.day)));

  const laid = SACG.layout(list);
  check('real capture lays out onto days', laid.length > 0, 'days=' + laid.length);
  check('no two sessions overlap within a lane', laid.every((d) =>
    d.sessions.every((a) => d.sessions.every((b) =>
      a === b || a.lane !== b.lane || a.startMin >= b.endMin || b.startMin >= a.endMin))));
  check('picks hold the leftmost lane in every day that has one', laid.every((d) => {
    const mine = d.sessions.filter((s) => s.mine);
    return !mine.length || Math.min.apply(null, mine.map((s) => s.lane)) === 0;
  }));
  check('lane 0 holds nothing but picks on days where you picked something', laid.every((d) => {
    if (!d.sessions.some((s) => s.mine)) return true;
    return d.sessions.filter((s) => s.lane === 0).every((s) => s.mine);
  }));

  if (navDays) {
    const seen = {};
    list.forEach((s) => { seen[s.day] = true; });
    const missing = navDays.filter((d) => d.date && !seen[d.date]);
    check('capture covers every day the navigation query advertises',
      missing.length === 0, 'missing=' + JSON.stringify(missing.map((d) => d.date)));
  } else {
    skip('capture covers every advertised day', 'no navigation query in this capture');
  }
}

function finish() {
  console.log('');
  if (failed) {
    console.log(failed + ' check(s) failed');
    process.exit(1);
  }
  console.log('all green' + (skipped ? ' (' + skipped + ' skipped)' : ''));
}

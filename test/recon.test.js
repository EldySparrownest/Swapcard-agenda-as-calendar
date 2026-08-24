// Minimal browser stub to exercise recon/swapcard-agenda-calendar-grid.recon.user.js under node.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.resolve(__dirname, '..', 'recon', 'swapcard-agenda-calendar-grid.recon.user.js');

const FAKE_JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2NmQxZmFhOSJ9.abcDEF123_-xyz';

// --- the response our fake Swapcard API returns -----------------------------
const apiResponse = {
  data: {
    plannings: {
      nodes: [{
        id: 'UGxhbm5pbmdfMTIz',
        title: 'Opening keynote',
        beginsAt: '2026-09-17T13:00:00+02:00',
        endsAt: '2026-09-17T14:00:00+02:00',
        speakers: [{ id: 'a', firstName: 'Ada', lastName: 'Lovelace' }]
      }]
    }
  },
  // things that must never survive into the dump:
  extensions: { refreshToken: FAKE_JWT }
};

// --- stubs ------------------------------------------------------------------
const listeners = {};
let downloaded = null;

const documentStub = {
  readyState: 'complete',
  body: { appendChild() {} },
  addEventListener() {},
  createElement(tag) {
    return {
      tag, style: {}, _click: false,
      set href(v) { this._href = v; }, get href() { return this._href; },
      addEventListener() {}, click() { downloaded = this; }, remove() {}
    };
  }
};

const sandbox = {
  console,
  setTimeout,
  WeakSet,
  Object,
  Array,
  JSON,
  Date,
  String,
  Blob: class Blob { constructor(parts) { this.parts = parts; } },
  URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
  navigator: { userAgent: 'node-test' },
  document: documentStub,
  XMLHttpRequest: function () {},
};

sandbox.window = sandbox;
sandbox.location = { href: 'https://app.swapcard.com/event/care-conference-2026/plannings/RXZ=' };
sandbox.XMLHttpRequest.prototype = {
  open() {}, send() {}, setRequestHeader() {}, addEventListener() {}
};

// original fetch: echoes back our canned API response
sandbox.fetch = function (url, init) {
  return Promise.resolve({
    status: 200,
    clone() {
      return { text: () => Promise.resolve(JSON.stringify(apiResponse)) };
    }
  });
};

vm.createContext(sandbox);
const src = fs.readFileSync(SCRIPT, 'utf8');
vm.runInContext(src, sandbox);

// --- exercise ---------------------------------------------------------------
const assert = require('assert');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); }
  catch (e) { failures++; console.log('  FAIL  ' + name + ' -> ' + e.message); }
}

sandbox.fetch(
  'https://api.swapcard.com/graphql',
  {
    method: 'POST',
    headers: { authorization: 'Bearer ' + FAKE_JWT, 'content-type': 'application/json' },
    body: JSON.stringify({
      operationName: 'EventPlannings',
      query: 'query EventPlannings($first: Int) { plannings { nodes { id title } } }',
      variables: { first: 20 }
    })
  }
).then(async (res) => {
  // response body must be untouched for the caller
  const passthrough = await res.clone().text();
  check('passes the response through unmodified', () => {
    assert.deepStrictEqual(JSON.parse(passthrough), apiResponse);
  });

  await new Promise((r) => setTimeout(r, 20)); // let the async tap settle

  const log = sandbox.window.__SACG.log;
  check('captured exactly one call', () => assert.strictEqual(log.length, 1));

  const entry = log[0];
  // NB: compare via JSON -- arrays built inside the vm realm are not reference-equal
  // to host arrays, which trips deepStrictEqual.
  check('recorded the operation name', () =>
    assert.strictEqual(JSON.stringify(entry.ops), '["EventPlannings"]'));
  check('recorded the endpoint', () => assert.strictEqual(entry.url, 'https://api.swapcard.com/graphql'));
  check('kept the query document', () =>
    assert.ok(entry.requestBody.query.includes('EventPlannings')));
  check('kept the session payload', () =>
    assert.strictEqual(entry.responseBody.data.plannings.nodes[0].title, 'Opening keynote'));
  check('kept speaker data', () =>
    assert.strictEqual(entry.responseBody.data.plannings.nodes[0].speakers[0].firstName, 'Ada'));

  check('redacted the Authorization header', () =>
    assert.ok(!JSON.stringify(entry.requestHeaders).includes('eyJ'),
      'header leaked: ' + JSON.stringify(entry.requestHeaders)));
  check('redacted refreshToken in the response body', () =>
    assert.ok(!JSON.stringify(entry.responseBody).includes('eyJ'),
      'body leaked: ' + JSON.stringify(entry.responseBody.extensions)));

  const payload = sandbox.window.__SACG.dump();
  const serialized = JSON.stringify(payload);
  check('full dump contains zero JWTs', () =>
    assert.ok(!serialized.includes('eyJ'), 'dump leaked a JWT'));
  check('dump triggered a download', () =>
    assert.ok(downloaded && /^swapcard-recon-\d+\.json$/.test(downloaded.download)));

  console.log(failures ? '\n' + failures + ' FAILED' : '\nall green');
  process.exit(failures ? 1 : 0);
}).catch((e) => { console.error('harness error:', e); process.exit(1); });

# Swapcard Agenda Calendar Grid

A Tampermonkey userscript that gives [Swapcard](https://app.swapcard.com) the agenda view it
doesn't have: **the whole event on a time axis**, with concurrent sessions side by side, your
own picks pinned to the leftmost lane, and speaker names on every block.

Swapcard shows the full agenda only as a grid/list, and offers a calendar only for sessions
you've already added. That makes the one question you actually need answered — *which of
these overlapping sessions do I go to?* — the one question it can't show you.

**Read-only.** The script never writes to Swapcard. Adding a session still happens through
Swapcard's own UI.

---

## Status

| Phase | What | State |
|---|---|---|
| 0 | `recon/` — capture Swapcard's API shape | ✅ done, see `recon/FINDINGS.md` |
| 1 | `swapcard-agenda-calendar-grid.user.js` — the calendar overlay | ✅ built, 46 checks green |

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Firefox.
2. Tampermonkey → Dashboard → **+** → paste the contents of `swapcard-agenda-calendar-grid.user.js` → save.
3. Open the event agenda and **reload the page once** (see the note below on why).
4. Click **Agenda grid**, top-right — below the profile picture.

   If a future Swapcard header changes height and the button lands badly, `BUTTON_TOP` and
   `BUTTON_RIGHT` at the top of the script are the whole fix.

Keys and controls: `Esc` closes, `+` / `−` zoom the time axis, day tabs switch days,
**Refresh** re-pulls your picks, clicking a block opens the details with an **Open in
Swapcard** link.

## What the grid shows

**One day at a time**, full width to that day's lanes, on a vertical time axis in the
**event's** timezone — not the viewer's. (Timestamps arrive with the event's UTC offset, and
the account default of `Africa/Abidjan` would otherwise shift every block.)

- **Lane 0 is reserved for sessions already on your schedule**, so *what would I give up?*
  is answerable by looking left. On a day where you have picked nothing there is nothing to
  reserve it for, and everything starts at lane 0 instead.
- **Double-booked picks** are not silently stacked: the earlier keeps lane 0, the later is
  outlined in amber with a `⚠`, and a banner above the day names every clash.
- Every other session takes greedy first-fit into lanes ≥ 1, so concurrent sessions never
  visually overlap.
- Blocks are colour-coded by activity type and carry time · type · title · speakers · room ·
  seats remaining, as far as the block's height allows.

There is also an **All days** tab that stacks the days vertically. The agreed design was one
day at a time; this is an opt-in extra, easy to drop if you don't want it.

### Why the reload matters

The script wraps `fetch` at `document-start`, before Swapcard's bundle loads, so it only
attaches on a real page load. Swapcard is a Next.js SPA: clicking from the home page into an
event changes the URL with no document load, and nothing is injected — Tampermonkey will
correctly say no script is running. **Reload once (Ctrl+R) while you're on the app**, and the
tap is armed for every client-side navigation after it.

If the badge still doesn't appear:

- Check the console for `[SACG] Swapcard Agenda Calendar Grid armed.` — if it's there, the tap is live and
  only the button failed.
- Tampermonkey → Dashboard: the script needs a green **Enabled** toggle, and the extension
  itself must not be paused.
- Never add a `@grant` line. `@grant none` is what keeps the script in the page context,
  the only place it can wrap the `fetch` that Swapcard's own bundle calls.

### Do I still need the recon script?

**No — disable it.** `swapcard-agenda-calendar-grid.user.js` carries its own network tap and learns the
endpoint, auth header and persisted-query hashes at runtime, so it needs nothing from
`recon/`. Running both at once is actively worse: two wrappers around `fetch`, two badges
competing for a corner, and the recon script keeps *every* captured response in memory
(up to 2 MB each, never evicted) — fine for a one-off capture, a slow leak over a
conference day.

Keep the file installed-but-disabled, or delete it from Tampermonkey entirely; it stays in
the repo either way. Re-enable it only if Swapcard changes its API and a fresh capture is
needed to update `recon/FINDINGS.md`.

---

## How it gets the data

Swapcard serves the agenda from two persisted GraphQL operations on `/api/graphql`. The full
contract is in **`recon/FINDINGS.md`**; the short version:

- `EventPlanningListViewNavigationQuery` → the event's day list, each with an `aggregationId`
- `PlanningListViewConnectionQuery` → one day of sessions, including
  `withEvent.bookmark.isBookmarked` — i.e. *this one is already on my schedule*

Both are **Automatic Persisted Queries**: the client sends only a `sha256Hash`, never a query
document, and that hash changes with every Swapcard deploy. So the script never hardcodes
one. It taps `fetch`, learns the endpoint, the auth header and the current hash from
Swapcard's own traffic, then replays the same operation for the days it hasn't seen yet.

If a replay fails — a stale hash after a redeploy, most likely — it degrades to **passive
harvesting**: click through the day tabs yourself and the calendar fills in. Sessions are
cached in `localStorage` per event+view, so it survives a reload either way.

The script issues no mutations. Its only outbound requests are replays of Swapcard's own
read queries.

---

## Tests

```sh
node test/recon.test.js       # the Phase 0 network tap and its redaction
node test/calendar.test.js    # parsing, lane packing, the fetch tap, store
```

`calendar.test.js` also replays a real `recon/swapcard-recon-*.json` through the parser as a
fixture when one is present, asserting that every session parses, that no two sessions share
a lane while overlapping, that your picks hold lane 0, and that the capture covers every day
the navigation query advertises. That file is gitignored, so those checks skip without it.

---

## Phase 0 — capturing a fresh API shape

Only needed if Swapcard changes its API and the findings above go stale.

1. Add `recon/swapcard-agenda-calendar-grid.recon.user.js` in Tampermonkey.
2. Open the agenda, scroll to the bottom, click through each day tab, and also visit
   `/my-schedule?view=schedule`.
3. Click the teal badge (or run `__SACG.dump()`) → downloads `swapcard-recon-<timestamp>.json`.

```js
__SACG.ops()    // table of GraphQL operation names seen so far
__SACG.log      // the raw captured entries
__SACG.clear()  // start over
```

### Before sharing that JSON — verify the redaction

The script strips `Authorization`/`Cookie` headers and any JWT-shaped value before writing
the file. Verify with:

```sh
grep -oE 'eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*' swapcard-recon-*.json | wc -l
```

**Zero is the only acceptable answer.** Note this looks for *three-segment* JWTs, not bare
`eyJ` — a plain `grep -c "eyJ"` is a false-positive machine, because `eyJ` is simply base64
for `{"` and every Swapcard `aggregationId` starts that way.

---

## Security note

Saved Swapcard pages are dangerous to keep around. A `Ctrl+S` or view-source capture of any
logged-in Swapcard page embeds `__NEXT_DATA__` containing a live `accessToken` **and a
`refreshToken` with no expiry claim** — anyone holding that file can mint fresh access tokens
until the session is revoked.

`.gitignore` therefore excludes `*.htm`, `*.html`, `*.har`, and `swapcard-recon-*.json`.
Use the redacted `__SACG.dump()` output instead of saving pages.

---

## Why a userscript and not a Firefox extension

Everything here is same-origin on `app.swapcard.com` — no cross-origin fetching, no
background worker, no toolbar UI, no storage beyond `localStorage`. An extension would add
real friction for nothing: release Firefox requires AMO signing for a permanent install, and
`about:debugging` temporary add-ons are wiped on restart. If it ever outgrows this, the code
moves into a content script nearly verbatim.

---

## Layout

```
Swapcard-agenda-as-calendar/
├── swapcard-agenda-calendar-grid.user.js                 # Phase 1: the calendar overlay
├── recon/
│   ├── swapcard-agenda-calendar-grid.recon.user.js       # Phase 0: network tap + redacted dump
│   └── FINDINGS.md                                       # the API contract Phase 1 is built against
├── test/
│   ├── calendar.test.js
│   └── recon.test.js
├── .gitignore
└── LICENSE
```

## When it breaks

The overlay renders its own DOM in a full-screen layer and reads only the GraphQL layer, so
a Swapcard restyle can't break it — there are no selectors into Swapcard's markup to go
stale, and the native view underneath is never touched or replaced. (The plan called for
mounting as a sibling of `[class*="main__Main-sc-"]` with their container hidden; a separate
layer turned out to reach the same result without depending on their class names at all, so
the planned `SELECTORS` object is not needed.) What can break:

- **A schema change** (a renamed field, the bookmark flag moving) — re-run Phase 0 and
  compare against `recon/FINDINGS.md`.
- **Persisted-query enforcement changing.** The script only ever replays a hash it has
  observed, so a redeploy costs at most one passive page load before it re-learns.
- **A day with more than 50 sessions** paginates; the replay follows `endCursor` up to 20
  pages, which is 1000 sessions.

If the grid looks empty but Swapcard shows sessions, open the console: every harvest logs
nothing by design, but `__SACG_CAL.store.all().length` tells you how many are cached.

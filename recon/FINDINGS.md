# Phase 0 findings — Swapcard's agenda API

Derived from a live capture of `app.swapcard.com` (client version `2.310.174`), event
`care-conference-2026`. This is what Phase 1 is built against.

## Transport

- **Endpoint:** `/api/graphql`, same-origin, `POST`.
- **Body is always a batch** — a JSON *array* of operation entries, even for one operation.
- **Auth:** an `authorization` header (a ~1.1 kB JWT). Also sent: `x-client-version`,
  `x-client-platform: Event App`, `x-client-origin`, `x-feature-flags`.
- **Automatic Persisted Queries.** The client sends **no query document** — only
  `extensions.persistedQuery.sha256Hash`. The hash is tied to the deployed bundle.

> Consequence for Phase 1: never hardcode a hash. Learn it at runtime from Swapcard's own
> traffic, then reuse it with different variables. When Swapcard redeploys, the next live
> request re-teaches the new hash automatically.

## The three operations that matter

### `EventPlanningListViewNavigationQuery`

Variables: `{ viewId, timezone }` — the event's day tabs.

```jsonc
{ "data": { "view": { "navigation": [
  { "aggregationId": "eyJkYXRhIjp7InJhbmdlIjpbMTc4OTU5NjAwMCwxNzg5NjgyNDAwXX19",
    "value": { "date": "2026-09-17T00:00:00+02:00" } }
] } } }
```

`aggregationId` is not opaque — it is base64 of `{"data":{"range":[startEpoch,endEpoch]}}`,
one local midnight-to-midnight day in seconds. Treat it as opaque anyway and pass it back
verbatim; this is just useful for debugging.

### `PlanningListViewConnectionQuery`

The agenda itself, one day per call.

```jsonc
{ "eventId": "RXZlbnRfNDQzODQxMA==", "withEvent": true,
  "viewId": "RXZlbnRWaWV3XzEyOTIzMjU=", "timezone": "Europe/Warsaw",
  "aggregationsIds": ["<one aggregationId>"], "after": null, "first": 50 }
```

Response: `data.view.plannings.{ nodes[], pageInfo{hasNextPage,endCursor}, totalCount }`.

A `Core_Planning` node:

| Field | Notes |
|---|---|
| `id` | base64 `Planning_<n>`; session page is `/event/<slug>/planning/<id>` |
| `beginsAt` / `endsAt` | ISO **with the event's UTC offset** (`2026-09-18T09:30:00+02:00`) |
| `type` | free text — `Talk`, `Keynote`, `Workshop`, `Meetups`, `Afterparty`, … |
| `place` | room string, e.g. `Amber Room · 1st Floor` |
| `format` | `PHYSICAL` \| `LIVE_STREAM` |
| `categories[]` | `{id, name, color}` — `color` was `null` throughout |
| `maxSeats` / `remainingSeats` | null unless the session has a seat cap |
| `htmlDescription` | event-authored HTML — flatten it, never inject it |
| `visibility` | `PUBLIC` for every session seen |
| `withEvent.title` | **the session title lives here**, not on the node |
| `withEvent.firstSpeakers[]` | `{id, firstName, lastName, organization, photoUrl}` |
| `withEvent.bookmark.isBookmarked` | **"already on my schedule"** |
| `withEvent.bookmark.canBookmark` | true throughout |

The bookmark flag riding along on the agenda query is the important find: the calendar can
mark your own picks without ever touching `/my-schedule`.

Timestamps carry their own offset, so read the wall clock off the string rather than going
through `Date` — otherwise the grid shifts for a viewer outside the event's timezone.

### `EventPlanningListViewBookmarkedPlannings`

Variables `{ eventId, withEvent }` → `data.agenda[]`, a slim list (`id`, times, title,
`format`, `liveStream`) of exactly the sessions you have bookmarked. Cheap, and
authoritative — Phase 1 replays it on open to correct stale cached flags.

## The capture this was derived from

| | |
|---|---|
| Days | 2026-09-17 → 2026-09-20 (`Europe/Warsaw`) |
| Sessions | 51 unique, `hasNextPage: false` on all four days at `first: 50` |
| Bookmarked | 13 |
| With speakers | 42 of 51 (1–6 speakers each) |
| Peak concurrency | 4 → the grid needs 4 lanes |

## Redaction note

The README tells you to verify a capture with `grep -c "eyJ"` and expect `0`. That check is
too blunt: `eyJ` is just base64 for `{"`, so every `aggregationId` trips it. The real capture
scored 13 hits and was clean — all 13 were day-range aggregation ids, zero JWT-shaped
(three-segment) strings. **Count three-segment matches instead:**

```sh
grep -oE 'eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*' swapcard-recon-*.json | wc -l
```

Zero is still the only acceptable answer for *that*.

# buffer-cal

Turns a Buffer publishing schedule into a calendar feed you can subscribe to in
Google Calendar, Apple Calendar, or Outlook. Connect Buffer, pick an
organization and channels, get a URL.

Runs as a single Cloudflare Worker with D1 and KV. No build step, no framework
beyond Hono.

## How it works

```
Buffer GraphQL API  ──▶  Worker  ──▶  /feed/<token>.ics  ──▶  your calendar app
                          │
                     D1 (users, calendars)
                     KV (rendered feeds)
```

A calendar client fetches `/feed/<token>.ics`. The Worker returns the cached
render if it is younger than the calendar's refresh interval, and otherwise
queries Buffer for posts in the window and renders a fresh feed.

## Three constraints worth knowing before you touch this

These are not incidental — they shaped the design.

**1. Google Calendar ignores your refresh interval.** Google re-fetches
subscribed URLs on its own undisclosed schedule, typically every 8–24 hours,
with no user setting and no manual refresh. Apple Calendar and Outlook honour
the `X-PUBLISHED-TTL` / `REFRESH-INTERVAL` this feed advertises; Google does
not. If you need Buffer changes to reach Google within minutes, an ICS
subscription fundamentally cannot deliver that — see [Not built yet](#not-built-yet).

**2. "CalDAV URL" is not the right primitive.** Google Calendar cannot subscribe
to a third-party CalDAV server; it is a CalDAV server, not a client. The
interoperable thing every calendar app accepts is an iCalendar (`.ics`) feed
over HTTP, which is what this serves.

**3. Buffer's rate limits are tight, and they are the real design constraint.**
Per credential: 100 requests / 15 min, 250 / 24 h (500 on Team), and 3,000 /
30 days on the lower plans. A naive 15-minute poll is ~2,880 requests/month and
would exhaust a free-tier budget on a single calendar.

Two things follow. Every feed response is served from KV within the refresh
interval, so **no volume of polling can drain a user's quota** — at most one
Buffer fetch per interval however often the URL is hit. And pagination is capped
at 10 pages per refresh, so one poll over a huge queue cannot spend an entire
daily budget. Quotas are scoped per credential, so in a multi-user deployment
each user spends their own.

## Authentication

Buffer has **not** enabled third-party OAuth on its GraphQL API — the documented
OAuth guide 404s, and app registration is closed. So users paste a personal API
key from [Buffer → Settings → API](https://publish.buffer.com/settings/api).
Connecting the key is also how a user signs in.

That key grants full access to its owner's Buffer account, including publishing.
It is validated against the API, sealed with AES-256-GCM under `ENCRYPTION_KEY`
before it reaches the database, and never logged or returned in a response body.
When Buffer does enable OAuth, it replaces `src/routes/auth.tsx` without touching
the rest of the app: everything downstream needs only a user and a credential.

## Setup

```bash
pnpm install
```

Create the D1 database and KV namespace, then put the returned IDs into
`wrangler.toml` (it ships with `PLACEHOLDER_REPLACE_AFTER_CREATE`):

```bash
npx wrangler d1 create buffer-cal
```

```bash
npx wrangler kv namespace create FEED_CACHE
```

Generate a 32-byte encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Local development

Put the key in `.dev.vars` (gitignored):

```
ENCRYPTION_KEY=<base64 32 bytes>
APP_BASE_URL=http://localhost:8787
```

```bash
pnpm db:migrate:local && pnpm dev
```

### Deploy

Set the secret, point `APP_BASE_URL` at your real origin in `wrangler.toml`,
migrate, and deploy:

```bash
npx wrangler secret put ENCRYPTION_KEY
```

```bash
pnpm db:migrate:remote && pnpm deploy
```

`APP_BASE_URL` must match the deployed origin — it is what the feed URLs shown
to users are built from.

## Tests

```bash
pnpm test
```

92 tests, no network access required. The parts worth knowing about:

- **`test/ics.test.ts`** — RFC 5545 serialization. Line folding is measured in
  UTF-8 octets and never splits a multi-byte character, which is the bug that
  corrupts feeds containing emoji.
- **`test/ics-roundtrip.test.ts`** — generated feeds are parsed back with
  `ical.js`, an independent implementation, using verbatim posts from a live
  Buffer account. Includes a case that walks a fold boundary across every byte
  of a 4-byte emoji.
- **`test/feed.test.ts`** — the caching and failure policy: a cache hit never
  reaches Buffer, and a Buffer outage serves the last good render rather than an
  empty calendar (which clients would read as every event being deleted).
- **`test/buffer-client.test.ts`** — rate-limit header parsing, error
  classification, pagination, and the page cap.
- **`test/crypto.test.ts`** — AES-GCM round-trip, tamper rejection, token entropy.

## Layout

| Path | What it does |
| --- | --- |
| `src/index.tsx` | Routes, middleware, error handling |
| `src/feed.ts` | Public ICS endpoint, caching, stale fallback |
| `src/ics/` | RFC 5545 serialization and post-to-event mapping |
| `src/buffer/` | GraphQL client, rate-limit handling, types |
| `src/routes/` | Connect flow and calendar management UI |
| `src/db.ts` | D1 access |
| `src/crypto.ts` | Credential sealing, token generation |
| `migrations/` | D1 schema |

## Design notes

**Event shape.** A Buffer post is a single instant with no duration, so events
get a fixed user-chosen length. Titles are `<emoji> <channel>: <excerpt>`;
descriptions carry the full text plus channel, status, tags, media count, and a
link to the post. Unpublished states (`draft`, `needs_approval`, `error`) are
`STATUS:TENTATIVE`; failures are prefixed `⚠️`. Events are `TRANSP:TRANSPARENT`
— they are informational, not time you are busy.

**`LAST-MODIFIED` comes from Buffer's own `updatedAt`**, so a client can tell a
real edit from the feed merely being regenerated. `DTSTAMP` carries the
generation time instead.

**Feed tokens are the only protection on the feed URL.** Calendar clients cannot
send credentials, so the endpoint has to be unauthenticated. Tokens are 32
random bytes, can be rotated from the UI, and the endpoint returns the same 404
for a malformed token and a deleted calendar. Feeds are served `noindex` with
`Referrer-Policy: no-referrer`.

**Channel names are resolved live.** The feed query fetches each post's channel
inline — costing a little query complexity but saving a whole request against
the rate limit — so a channel renamed in Buffer is reflected immediately, with
the stored name as fallback.

## Not built yet

**Google Calendar API push.** The one thing an ICS feed cannot do is update
Google quickly. Writing events into a dedicated Google calendar via the Calendar
API would give real control over sync frequency and native editable events, at
the cost of Google OAuth, a scheduler (Cloudflare cron triggers go down to the
minute), and stored event-ID mappings for create/update/delete reconciliation.
The sync core here is already separated from the ICS rendering, so this slots in
alongside rather than replacing it.

Also absent: no `sent` post is included if Buffer recorded no `dueAt` for it,
since the feed filters on `dueAt` server-side to avoid fetching and discarding
unscheduled drafts. The post permalink (`publish.buffer.com/post/<id>`) is
best-effort — Buffer does not document a canonical one.

# buffer-cally

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
subscription fundamentally cannot deliver that, which is why the [Google
Calendar push](#google-calendar-push) exists.

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

Buffer **does** support OAuth — authorization code + PKCE against
`auth.buffer.com/auth` and `/token`. Its published docs are thin (the OAuth guide
404s), which is easy to mistake for the feature not existing; it exists.

Two things to know. OAuth requires a **public HTTPS redirect URI**, so it cannot
be exercised from plain localhost — a Cloudflare `*.workers.dev` origin satisfies
it for free. And Buffer **rotates the refresh token on every use**, so the newly
returned one must always be persisted; in a server app hit concurrently, refreshes
must be single-flighted or two of them will invalidate each other.

Until this deployment registers a client, users paste a personal API key from
[Buffer → Settings → API](https://publish.buffer.com/settings/api). Connecting the
key is also how a user signs in.

That key grants full access to its owner's Buffer account, including publishing —
which is why OAuth is worth moving to, since it can request read-only scopes. The
key is validated against the API, sealed with AES-256-GCM under `ENCRYPTION_KEY`
before it reaches the database, and never logged or returned in a response body.
Swapping in OAuth replaces `src/routes/auth.tsx` without touching
the rest of the app: everything downstream needs only a user and a credential.

## Setup

```bash
pnpm install
```

Create the D1 database and KV namespace, then put the returned IDs into
`wrangler.toml` (it ships with `PLACEHOLDER_REPLACE_AFTER_CREATE`):

```bash
npx wrangler d1 create buffer-cally
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

Runs on Cloudflare Workers. Netlify is not an option without a rewrite: the app
uses D1 and KV bindings directly, so moving hosts means replacing the whole
storage layer with an external database.

**1. Authenticate.** Opens a browser to authorize your Cloudflare account:

```bash
npx wrangler login
```

**2. Create the storage** and paste the returned IDs into `wrangler.toml`, which
ships with `PLACEHOLDER_REPLACE_AFTER_CREATE` in both slots:

```bash
npx wrangler d1 create buffer-cally && npx wrangler kv namespace create FEED_CACHE
```

**3. Set the encryption secret.** Use a *different* key from your local one:

```bash
npx wrangler secret put ENCRYPTION_KEY
```

**4. Deploy once to learn your origin.** Cloudflare assigns
`https://buffer-cally.<your-subdomain>.workers.dev`:

```bash
pnpm db:migrate:remote && pnpm deploy
```

**5. Set `APP_BASE_URL`** in `wrangler.toml` to that exact origin and deploy
again. It is what the feed URLs and OAuth redirect are built from, so a mismatch
breaks both.

The cron trigger (`*/5 * * * *`) activates on deploy. It costs nothing when no
calendar has push enabled — the query returns no rows and the tick exits.

### Buffer OAuth

Buffer requires a **public HTTPS redirect URI**, so this only works once
deployed. Register a client under Buffer → Settings → API with:

```
https://buffer-cally.<your-subdomain>.workers.dev/auth/callback
```

A Worker can hold a secret, so register a **confidential** client and keep PKCE
as well. Remember that Buffer rotates the refresh token on every use — see
[Authentication](#authentication).

### Google Calendar push (optional)

Skip this and the ICS feed still works; the push UI simply stays hidden.

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/), enable the **Google Calendar API**.
2. Configure the OAuth consent screen. The only scope needed is
   `https://www.googleapis.com/auth/calendar.app.created` — narrow by design, so
   the app cannot see calendars it did not create. While the screen is in
   *Testing*, add yourself as a test user; publishing it for other people
   requires Google verification.
3. Create an **OAuth client ID** of type *Web application* with redirect URI
   `https://buffer-cally.<your-subdomain>.workers.dev/google/callback`.
4. Put the client ID in `wrangler.toml` under `[vars]` as `GOOGLE_CLIENT_ID`, and
   set the secret:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

For local development, add both to `.dev.vars` and register
`http://localhost:8787/google/callback` as an additional redirect URI. Google
permits localhost redirects; Buffer does not.

`APP_BASE_URL` must match the deployed origin — it is what the feed URLs shown
to users are built from.

## Tests

```bash
pnpm test
```

113 tests, no network access required. The parts worth knowing about:

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
- **`test/reconcile.test.ts`** — what the Google push creates, updates, and
  deletes. Covers the injectivity of event IDs (the reason post IDs are hex-encoded
  unconditionally rather than used raw when already valid) and the guarantee that
  an event the user added themselves can never be planned for removal.
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

## Google Calendar push

Both paths ship. The ICS feed is universal; the push is what makes Google timely,
since Google ignores the refresh interval on subscribed URLs.

It needs no local event-mapping table. A Google event ID is derived from the
Buffer post ID, and Buffer's `updatedAt` is stored on the event itself in
`extendedProperties`, so Google holds the entire sync state and nothing can drift
from a database row. Every written event carries a private owner tag and
`events.list` filters on it, so reconciliation can only ever see — and therefore
only ever delete — events this tool created. An event you add to that calendar
yourself is invisible to the sync.

Turning push off leaves the Google calendar and its events in place; removing a
calendar from someone's account is not this tool's decision. There is a separate,
explicit "delete the Google calendar" action.

## Still to do

- **Buffer OAuth.** Registered but not yet wired into `src/routes/auth.tsx`;
  users still paste an API key.
- **No `sent` post appears** if Buffer recorded no `dueAt` for it,   since the feed filters on `dueAt` server-side to avoid fetching and discarding
  unscheduled drafts.
- **The post permalink** (`publish.buffer.com/post/<id>`) is best-effort — Buffer
  does not document a canonical one.
- **The privacy policy** has bracketed placeholders for the operator name and
  contact address, which must be filled in before anyone else uses this.

# social-cally

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

OAuth requires a **public HTTPS redirect URI**, so it cannot be exercised from
plain localhost — any deployed origin satisfies it. Scopes requested are
`account:read`, `posts:read`, `offline_access`: read-only, because the app never
publishes.

### The refresh token rotates, and that is a race

Buffer issues a **new refresh token on every refresh and invalidates the old
one**. Persisting what comes back is necessary but not sufficient: the cron tick
and a browser request can refresh the same user simultaneously, both spend token
A, and whichever lands second gets `invalid_grant`. Handled naively that logs out
a user whose grant is perfectly healthy.

`src/buffer/token.ts` uses two mechanisms, because neither works alone:

- a **KV lock**, which narrows the window but is advisory only — KV has no
  compare-and-set, so it cannot actually exclude; and
- on `invalid_grant`, **re-reading the row from D1** — strongly consistent,
  unlike KV — and retrying if `updated_at` moved, meaning another in-flight
  refresh already stored a newer token.

The second is what makes it correct. A transient 5xx is deliberately *not*
treated as a rotation conflict, so it fails fast instead of retrying.

### Re-authorizing returns no refresh token

An authorization the user has already approved comes back **without a refresh
token**, because the server skips the approval screen it would have issued one
from. The grant is fine; the response simply carries nothing durable. This only
bites on the *second* sign-in — a new device, a new browser, a cleared cookie —
so the flow looks healthy right up until someone tries it twice.

Two things stop it, in `src/buffer/oauth.ts` and `src/routes/auth.tsx`:

- the sign-in link sends **`prompt=consent`**, asking for the approval screen
  back. Google's client already did this; Buffer's did not; and
- a token response with no refresh token **falls back to the grant already on
  file**. The absence of a token in *this* response says nothing about the one
  in the database, and that stored token is still rotating happily. Only when
  there is nothing to fall back on is the sign-in genuinely refused — and it
  never overwrites a live grant with nothing.

`prompt` cannot be exercised outside the deployed origin, so if Buffer rejects
the parameter the callback retries once without it (`promptRejected`). The cost
of being wrong about it is one extra redirect, not a sign-in page nobody can get
past.

### Two credential kinds

Either way the result downstream is identical — a user row plus a credential —
and every caller resolves through `bufferTokenFor`, so the ICS feed, the setup UI
and the cron share one path and a rotation persisted by any is seen by the rest.

**OAuth** is the primary route wherever `BUFFER_CLIENT_ID` is set. Only the
refresh token is persisted, sealed with AES-256-GCM under `ENCRYPTION_KEY`;
access tokens live in KV under their own expiry and never reach the database.

**A pasted personal API key** remains as the fallback when no client is
registered, and keeps working for accounts that already use one. It grants full
account access including publishing, which is exactly why OAuth is preferred —
connecting via OAuth deletes any stored key rather than leaving a full-access
credential at rest. Keys are validated against the API before storage, sealed the
same way, and never logged or returned in a response body.

## Local development

No Cloudflare account is needed for this — `wrangler dev` emulates D1 and KV on
disk. Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put it in `.dev.vars` (gitignored), which is the whole local config:

```
ENCRYPTION_KEY=<base64 32 bytes>
APP_BASE_URL=http://localhost:8787
```

```bash
pnpm install && pnpm db:migrate:local && pnpm dev
```

## Deploy

Runs on Cloudflare Workers. Netlify is not an option without a rewrite: the app
uses D1 and KV bindings directly, so moving hosts means replacing the whole
storage layer with an external database.

**1. Authenticate.** Opens a browser to authorize your Cloudflare account:

```bash
npx wrangler login
```

**2. Create the storage** and paste the returned IDs into `wrangler.toml`:

```bash
npx wrangler d1 create social-cally && npx wrangler kv namespace create FEED_CACHE
```

If you lose that output, the IDs are not gone and the resources should not be
recreated — `create` is just the first place they are printed, not the only one:

```bash
npx wrangler d1 list && npx wrangler kv namespace list
```

Both IDs belong in version control. They are account-scoped resource handles,
not credentials; reaching the data behind them still requires an authenticated
token. The real secrets go through `wrangler secret put` and never appear here.

**3. Set the encryption secret.** Use a *different* key from your local one:

```bash
npx wrangler secret put ENCRYPTION_KEY
```

**4. Deploy once to learn your origin.**

```bash
pnpm db:migrate:remote && pnpm release
```

Out of the box Cloudflare assigns `https://social-cally.<your-subdomain>.workers.dev`.
To serve from your own hostname instead, put its zone on Cloudflare and declare a
Custom Domain in `wrangler.toml` — Cloudflare then creates the proxied DNS record
and provisions the certificate for you:

```toml
[[routes]]
pattern = "cally.example.com"
custom_domain = true
```

Be aware that declaring **any** route flips `workers_dev` to `false`, retiring the
`*.workers.dev` origin. That is usually what you want — one hostname, one OAuth
redirect URI — but it does mean the old URL stops answering. Set
`workers_dev = true` explicitly to keep both. This deployment runs at
[social-cally.bgreen.lol](https://social-cally.bgreen.lol).

**5. Set `APP_BASE_URL`** in `wrangler.toml` to that exact origin and deploy
again. It is what the feed URLs and OAuth redirect are built from, so a mismatch
breaks both. Note that ICS UIDs are *not* derived from it — they carry a fixed
`@social-cally` namespace — so changing hosts later will not orphan events that
subscribers already have.

The cron trigger (`*/5 * * * *`) activates on deploy. It costs nothing when no
calendar has push enabled — the query returns no rows and the tick exits.

### Deploying on push (Workers Builds)

Deploys are wired to the repository through **Workers Builds**, Cloudflare's own
Git integration — no workflow file, no API token in GitHub. Everything lives in
the dashboard under the Worker → **Settings → Build**, where the GitHub repo is
connected. There is deliberately no `.github/workflows` here; adding one would
mean two systems racing to deploy the same commit.

| Field | Value |
|---|---|
| Build command | `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` |
| Deploy command | `npx wrangler deploy` (the default) |
| Non-production deploy command | `npx wrangler versions upload` (the default) |
| Root directory | *(blank — not a monorepo)* |

The build command is where the gate lives. Cloudflare runs it before the deploy
command and a non-zero exit stops the build, so a failing typecheck or a red
test suite never reaches production. That is the whole reason to put the checks
there rather than trusting a green local run.

Pushes to `main` deploy. Every other branch runs the **non-production** command,
which uploads a version and gives it a preview URL without taking production
traffic — so a pull request gets a real, reachable build of itself and the live
Worker is untouched.

#### Migrations stay manual, on purpose

The API token Cloudflare generates for Workers Builds grants Workers Scripts,
KV, R2, Workers Routes, and read on Account Settings — **not D1**. So
`wrangler d1 migrations apply --remote` cannot run from a build with the default
token, and a schema change has to be applied by hand *before* merging the code
that depends on it:

```bash
pnpm db:migrate:remote
```

That ordering is not fussiness. An additive migration leaves the old code
running against a schema with columns it ignores, which is harmless; new code
against the old schema is an outage until someone notices. Migrating first, then
merging, is the safe direction.

To automate it anyway, create a token that also has **D1 → Edit**, set it under
the Build settings' API token, and move migrations into the deploy command. The
default token is chosen here because a deploy credential that cannot alter the
database is a smaller thing to lose.

Deploying by hand still works and is unchanged: `pnpm release`.

### Buffer OAuth

Buffer requires a **public HTTPS redirect URI**, so this only works once
deployed. Register a client under Buffer → Settings → API with:

```
https://<your-origin>/auth/callback
```

Then set the client ID. It is **not a secret** — it travels in the redirect URL
every user's browser follows — so it belongs in `wrangler.toml` under `[vars]`,
in version control:

```toml
[vars]
BUFFER_CLIENT_ID = "your-client-id"
```

The client *secret* is optional. Buffer accepts public clients on PKCE alone,
but a Worker can hold a secret, so set one if your client is confidential:

```bash
npx wrangler secret put BUFFER_CLIENT_SECRET
```

Deploy after changing either. With no `BUFFER_CLIENT_ID` the connect page simply
falls back to the pasted API key, so an unconfigured deployment still works.

Scopes requested are `account:read`, `posts:read`, and `offline_access` —
read-only, deliberately excluding the `posts:write` and `ideas:write` that
Buffer's own clients ask for, because this tool never publishes.

Remember that Buffer rotates the refresh token on every use — see
[Authentication](#authentication).

### Enabling the Google push

Skip this and the ICS feed still works; the push UI simply stays hidden.

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/), enable the **Google Calendar API**.
2. Configure the OAuth consent screen. The only scope needed is
   `https://www.googleapis.com/auth/calendar.app.created` — narrow by design, so
   the app cannot see calendars it did not create. While the screen is in
   *Testing*, add yourself as a test user; publishing it for other people
   requires Google verification.
3. Create an **OAuth client ID** of type *Web application* with redirect URI
   `https://<your-origin>/google/callback`.
4. Put the client ID in `wrangler.toml` under `[vars]` as `GOOGLE_CLIENT_ID`, and
   set the secret:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

For local development, add both to `.dev.vars` and register
`http://localhost:8787/google/callback` as an additional redirect URI. Google
permits localhost redirects; Buffer does not.

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

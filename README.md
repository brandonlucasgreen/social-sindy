# social sindy

Turns your Buffer publishing schedule and history into subscribable feeds — calendar feeds (ICS) and content feeds (Atom/RSS) — from a single read-only OAuth connection.

Live at **[socialsindy.com](https://socialsindy.com)**. Not affiliated with Buffer, Inc.

## What it does

Sign in with Buffer once, then create **sindies**. Each sindy is one feed, in one of two formats:

- **Calendar feed (ICS)** — subscribe in Google Calendar, Apple Calendar, or Outlook. Each scheduled or published post becomes a timed event, colored by network.
- **Content feed (Atom/RSS)** — subscribe in any RSS reader, or pipe it into an email tool. Each post becomes an entry with full text, channel metadata, and media attachments.

Every sindy has its own channel selection, date window, refresh interval, and private share URL. One Buffer connection can produce as many of both as you want.

### Per-sindy settings

| Setting | Options | Applies to |
|---------|---------|------------|
| Refresh interval | hourly, every 6 hours, daily | both |
| Past window | upcoming only, 7 / 30 / 90 days | both |
| Future window | configurable day count | both |
| Post statuses | scheduled, sent | both |
| Event duration | 15 / 30 / 60 minutes | ICS |
| Channel name in title | on/off | ICS |
| Max items | default 50 | Atom |
| Group cross-posts into one entry | on/off | Atom |

The share URL can be regenerated at any time, which immediately invalidates the old one.

### Google Calendar push (built, currently off)

Google Calendar re-fetches subscribed ICS feeds on its own 8–24 hour schedule. To make ICS outputs update within minutes instead, the code can write events directly into a dedicated secondary Google calendar via the Calendar API, reconciling on each cron tick — creating new events, updating changed ones, removing deleted ones. It only ever touches events it created (tagged with a private extended property) and never reads or modifies existing calendars.

**This is disabled in the deployed app.** `GOOGLE_CLIENT_ID` is commented out in [wrangler.toml](wrangler.toml) pending Google OAuth verification of the `calendar.app.created` scope. While the consent screen sits in Testing, Google expires refresh tokens after 7 days, which would break the push weekly for anyone who enabled it. With the variable unset the push UI is hidden, `/google/*` returns 501, and the cron finds nothing to sync. Uncomment the line to re-enable. See [docs/google-verification.md](docs/google-verification.md).

## Setup

### Prerequisites

- Node.js 22+
- pnpm 10+
- A Cloudflare account with Workers, D1, and KV access
- A Buffer OAuth client

### Install

```bash
pnpm install
```

### Local development

```bash
pnpm db:migrate:local
```

```bash
pnpm dev
```

The Worker runs on `http://localhost:8787`. Buffer OAuth requires a public HTTPS redirect URI, so sign-in itself is only testable on a deployed origin — feed rendering, ICS/Atom generation, and the management UI all work locally against seeded data.

### Secrets

```bash
wrangler secret put ENCRYPTION_KEY
```

| Secret | Required | Purpose |
|--------|----------|---------|
| `ENCRYPTION_KEY` | yes | base64 32-byte AES-256-GCM key wrapping stored credentials |
| `BUFFER_CLIENT_SECRET` | no | Buffer accepts public clients on PKCE alone; set it if your client is confidential |
| `GOOGLE_CLIENT_SECRET` | no | only for the Google Calendar push |

Public config (base URL, Buffer client ID) lives in `[vars]` in [wrangler.toml](wrangler.toml), not in secrets — a client ID ships in every user's redirect URL and is not sensitive.

### Deploy

```bash
pnpm db:migrate:remote
```

```bash
pnpm release
```

### Type checking & tests

```bash
pnpm typecheck
```

```bash
pnpm test
```

Both run on every pull request via [GitHub Actions](.github/workflows/ci.yml).

## Architecture

One Cloudflare Worker. One D1 database. One KV namespace. One Buffer OAuth connection per user.

```
src/
  index.tsx            — router, feed dispatch (ICS + Atom), scheduled push handler
  db.ts                — D1 data access (unified `outputs` table)
  feed.ts              — feed rendering with KV cache, ETag, stale fallback
  present.ts           — shared post-to-event/entry presentation, network colors
  crypto.ts            — AES-256-GCM envelope encryption
  session.ts           — sessions, Buffer client resolution, short-lived lookup cache
  env.ts               — Worker bindings type
  buffer/              — GraphQL client, OAuth (PKCE), token rotation
  ics/                 — ICS generation (RFC 5545) and serialization
  atom/                — Atom generation (RFC 4287)
  google/              — Calendar API client, OAuth
  sync/                — posts fetcher, Google push, reconciliation, push config
  routes/              — auth (landing + OAuth), outputs (sindy management), faq,
                         google (push), privacy
  ui/                  — layout and styles, brand mark
migrations/            — 0001_init → 0004_unified_outputs
test/                  — crypto, ICS round-trip, Atom, feed cache, Buffer client
                         + OAuth, auth callback, reconciliation, indexability
```

### Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `/` | public | landing page; "Sign in with Buffer" |
| `/auth/buffer`, `/auth/callback` | public | OAuth round trip (PKCE, verifier held server-side) |
| `/sindies`, `/sindies/*` | session | create, view, edit, delete sindies |
| `/google/*` | session | Google connection and push controls (501 when disabled) |
| `/faq`, `/privacy` | public | FAQ and privacy policy |
| `/feed/:token.ics` | token | the ICS feed calendar clients poll |
| `/feed/:token.xml` | token | the Atom feed RSS readers poll |
| `/healthz`, `/icon.svg` | public | health check, favicon |

Feed routes are registered ahead of the session and CSRF middleware on purpose: calendar clients and RSS readers send no cookies and no `Origin` header, and those routes must stay plain, cheap GETs.

### Domains

`socialsindy.com` is primary. Two older hostnames, `social-sindy.bgreen.lol` and `social-cally.bgreen.lol`, remain routed to the same Worker — not because the names are still in use, but because feed URLs on them are sitting in real calendar clients and RSS readers. Dropping a route silently breaks every subscriber pointed at it.

## Principles

- **Read-only.** No post is ever created, edited, or deleted in Buffer. The OAuth scopes make this structural, not a promise.
- **Least privilege.** Buffer: `account:read`, `posts:read`, `offline_access`. Google: `calendar.app.created` only — it cannot see existing calendars.
- **Never waste quota.** Buffer's budget can be as low as 250 requests per 24 hours. Feed responses are cached in KV within each sindy's refresh interval, so no volume of client polling can drain it. ICS rendering and Google push share a single Buffer fetch.
- **Stale > empty.** A transient Buffer failure serves the last successful render. An empty feed would read to clients as "every event was deleted."
- **Honest about latency.** Refresh intervals are advertised to clients. Google's 8–24 hour polling schedule is acknowledged in the UI, not hidden.
- **Encrypted at rest.** Buffer credentials are sealed with AES-256-GCM and never written to a log.

### A note on the pasted-API-key path

Early versions let you paste a Buffer personal API key instead of using OAuth. That option is **removed from the UI** because a personal key grants full account access, including publishing. The `POST /connect` route still exists so accounts created that way keep working, and signing in with OAuth deletes the stored key rather than leaving a full-access credential at rest.

## Naming

The product is **social sindy** — a syndication pun, **S**yndication + **Indy** (independent). The hyphenated `social-sindy` is the identifier everywhere one is needed: package name, Worker name, D1 database name, and ICS UID domain. The spaced `social sindy` appears in the UI, page titles, and privacy policy.

The project had an earlier name, from when it produced calendars only. That name is retired and should not appear in code, config, or copy — the sole exception is the legacy hostname above, which exists for subscribers rather than as a name.

## Contributing

Pull requests are welcome, though this is a personal project with a narrow scope — please open an issue before starting anything substantial. `main` is protected: changes land via pull request with `pnpm typecheck` and `pnpm test` passing.

## License

[MIT](LICENSE).

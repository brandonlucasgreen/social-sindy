# social-sindy

Turns your Buffer publishing schedule and history into subscribable feeds — calendar feeds (ICS) and content feeds (Atom/RSS) — from a single OAuth connection.

## What it does

Connect Buffer once, then create outputs. Each output is either:

- **A calendar feed (ICS)** — subscribe in Google Calendar, Apple Calendar, or Outlook. Each scheduled or published post becomes a calendar event.
- **A content feed (Atom/RSS)** — subscribe in any RSS reader. Each post becomes a feed entry with full text, channel metadata, and media attachments.

Each output has its own channel selection, date window, refresh interval, and share URL. One Buffer connection can produce both.

### Google Calendar push (optional, ICS only)

Google Calendar re-fetches subscribed ICS feeds on its own 8–24 hour schedule. For ICS outputs, you can optionally enable direct Google Calendar push: events are written straight into a dedicated Google calendar via the API, so changes appear within minutes instead of hours.

The push creates its own secondary calendar — it never touches your existing calendars. Only events created by this tool are ever modified or deleted.

## Setup

### Prerequisites

- Node.js 22+
- pnpm 10+
- A Cloudflare account with Workers, D1, and KV access
- A Buffer OAuth client (or use a personal API key)

### Install

```bash
pnpm install
```

### Local development

```bash
pnpm db:migrate:local
pnpm dev
```

The Worker runs on `http://localhost:8787`. Buffer OAuth requires a public HTTPS redirect URI, so sign-in is only testable on the deployed origin. The API-key fallback works locally.

### Secrets

```bash
wrangler secret put ENCRYPTION_KEY        # base64 32-byte AES-256-GCM key
wrangler secret put BUFFER_CLIENT_SECRET  # optional (PKCE-only works without it)
wrangler secret put GOOGLE_CLIENT_SECRET  # only for Google Calendar push
```

### Deploy

```bash
pnpm db:migrate:remote
pnpm release
```

### Type checking & tests

```bash
pnpm typecheck
pnpm test
```

## Architecture

One Cloudflare Worker. One D1 database. One KV namespace. One Buffer OAuth connection per user.

```
src/
  index.tsx          — main router, feed dispatch (ICS + Atom), scheduled push
  db.ts              — D1 data access (unified outputs table)
  feed.ts            — feed rendering with KV cache (both formats)
  present.ts         — shared post-to-event/entry presentation
  crypto.ts          — AES-256-GCM envelope encryption
  session.ts         — session handling, Buffer client resolution
  env.ts             — Worker bindings type
  buffer/            — Buffer GraphQL client, OAuth, token rotation
  ics/               — ICS generation (RFC 5545)
  atom/              — Atom generation (RFC 4287)
  google/            — Google Calendar API client, OAuth
  sync/              — posts fetcher, Google push, reconciliation
  routes/            — auth, outputs (management UI), google (push), privacy
  ui/                — layout, mark
migrations/
  0001_init.sql
  0002_google_push.sql
  0003_buffer_oauth.sql
  0004_unified_outputs.sql
```

## Principles

- **Read-only.** Never creates, edits, or deletes a post in Buffer.
- **Least privilege.** Buffer: `account:read`, `posts:read`, `offline_access`. Google: `calendar.app.created` only.
- **Never waste quota.** Feed responses are cached in KV within the refresh interval. ICS and Google push share a single Buffer fetch.
- **Stale > empty.** A Buffer failure serves the last successful render, never an empty feed.
- **Honest about latency.** Refresh intervals are advertised to clients. Google's polling schedule is acknowledged, not hidden.

## License

Private.
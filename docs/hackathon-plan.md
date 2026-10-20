# Hackathon plan: syndicating out through open protocols

Social sindy already turns Buffer posts into things other software can read: ICS, Atom, an embeddable widget. This plan adds four outputs that *push* instead of waiting to be polled:

| Output | Protocol | Audience | Shape in the code |
|---|---|---|---|
| **Slack** | Slack incoming webhooks (also accepted, with tweaks, by Discord, Mattermost and Rocket.Chat), Slack app later | Internal: drafts, scheduled, approvals, failures | New format `slack` |
| **Email digest** | SMTP via a provider API | Internal | New format `email` |
| **WebSub** | W3C WebSub, self-hosted hub | Whoever holds the Atom URL | Enhancement to `atom` |
| **Micropub** | W3C Micropub + IndieAuth | Public: sent posts only, written to the user's own site | New format `micropub` |

All four depend on one new piece, the **change-event engine**: the system notices that a post was scheduled, sent, failed or sent for approval, and turns that into an event. Build it first; each output is then a small handler on top.

Nothing here changes the read-only contract with Buffer. Micropub writes to the *user's own website*, never to Buffer.

---

## Phase 0: Foundations

### 0.1 Audience rules per format

Today `readSettings` in `src/routes/outputs.tsx` limits statuses per format in separate branches (widget is forced to `sent`; Atom allows `sent` and optionally `draft`). Make this one explicit table, so a new public format can't leak drafts:

```ts
// src/formats.ts (new)
export const ALLOWED_STATUSES: Record<OutputFormat, readonly PostStatus[]> = {
  ics: POST_STATUSES,
  atom: ['sent', 'draft'],
  widget: ['sent'],
  slack: POST_STATUSES,   // internal
  email: POST_STATUSES,   // internal
  micropub: ['sent'],     // public, written to someone's website
};
```

`readSettings` intersects the submitted statuses with this table, and `postsForOutput` re-applies it on read, so a bad row can't widen what is shown either.

- `OutputFormat` / `isOutputFormat` in `src/db.ts`: add `slack | email | micropub`.
- `FORMATS`, `FORMAT_LABEL`, `FORMAT_NOUN`, `ITEM_NOUN`, `NAME_LABEL`, `CHANNEL_PROMPT` in `src/routes/outputs.tsx`: one entry each.
- `/feed/:file` and `/embed/:token` in `src/index.tsx` already return 404 for formats they don't serve. Keep it that way: the new formats have no public URL.

### 0.2 Tag filter (every format)

Buffer's `PostsFiltersInput` has `tags: TagComparator { in: [TagId!]!, isEmpty }`, so the filtering happens on Buffer's side and costs nothing extra.

- Migration `0006_tags.sql`: `ALTER TABLE outputs ADD COLUMN tag_ids TEXT;` (comma-separated like `statuses`; null means all).
- `src/buffer/client.ts`: add `tagIds?: string[]` to `FetchPostsParams` and pass it as `filter.tags`. Add `fetchTags(organizationId)` using `tagsV2` for the picker. Picker results go in the KV cache, not fetched on every form render.
- `src/sync/posts.ts`: pass `tag_ids` through. `cacheKey` already includes `updated_at`, so editing tags invalidates the cache.
- UI: a tag multi-select under the channel picker in `src/routes/outputs.tsx`. Shown for every format.
- Tests: extend `test/buffer-client.test.ts` to check that the request carries the filter.

### 0.3 Change-event engine

`planSync` in `src/sync/reconcile.ts` is the pattern to copy, not the code to reuse: it diffs against Google, which holds the sync state. Here the state has to live with us.

**State**, migration `0007_events.sql`:

```sql
-- Last-seen state of each post an output is watching. Rows change only when a
-- post does, so a quiet tick costs one read.
CREATE TABLE output_post_state (
  output_id   TEXT NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  post_id     TEXT NOT NULL,
  status      TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  due_at      TEXT,
  -- Set once a time-based event (e.g. "going out in an hour") has fired.
  notified    TEXT,
  PRIMARY KEY (output_id, post_id)
);

ALTER TABLE outputs ADD COLUMN watch_baselined_at TEXT;
ALTER TABLE outputs ADD COLUMN last_watch_at TEXT;
ALTER TABLE outputs ADD COLUMN last_delivery_error TEXT;
```

Add both tables to `deleteUser` and `deleteOutput` in `src/db.ts`, which delete explicitly rather than rely on cascades.

**Diff**, `src/events/detect.ts` (pure, no I/O, like `reconcile.ts`):

```ts
export type PostEventType =
  | 'post.scheduled'        // new post in scheduled state
  | 'post.updated'          // pending post's updatedAt moved
  | 'post.needs_approval'
  | 'post.sent'
  | 'post.failed'           // status error; carries error.message + supportUrl
  | 'post.upcoming';        // dueAt within lead time, not yet notified

export interface PostEvent { type: PostEventType; post: BufferPost; previous?: PriorState }

export function detectEvents(
  previous: Map<string, PriorState>,
  current: BufferPost[],
  opts: { now: Date; baselined: boolean; upcomingLeadMinutes?: number },
): { events: PostEvent[]; nextState: PriorState[] };
```

Rules:
- **First run emits nothing.** It records a baseline, so connecting Slack doesn't dump 200 "new post" messages into a channel.
- A post seen for the first time already `sent` (e.g. "Share now" between ticks) emits `post.sent` only if `sentAt` is after `watch_baselined_at`.
- A post that disappears emits nothing. Deleted, rescheduled out of the window and filtered out by a tag change all look the same, and guessing wrong spams people.
- Status transitions take precedence over `post.updated`.

Tests in `test/events.test.ts`: the baseline, each transition, Share-now, disappearance, and the upcoming-lead window.

**Scheduler**: generalize `scheduled()` in `src/index.tsx`.

```ts
async function scheduled(_e, env, ctx) {
  await runGooglePush(env);   // the existing body, unchanged
  await runWatches(env);      // new
}
```

- `outputsDueForWatch(db, now, limit)` in `src/db.ts`: the same shape as `outputsDueForPush`, selecting `format IN ('slack','email','micropub')`, plus Atom outputs with at least one live WebSub subscription, where `last_watch_at` is older than `refresh_minutes`.
- `src/events/watch.ts`: `postsForOutput` (shared KV cache, so a watched Atom feed and its readers spend one fetch), then `detectEvents`, persisting changed state rows in one `db.batch`, then `dispatch(format, events)`.
- `src/events/dispatch.ts`: a `Record<OutputFormat, Handler>`. Each handler records its own `last_delivery_error`. One failure doesn't stop the tick, the same as the push loop.

**Quota.** Each watched sindy costs about one Buffer request per refresh interval (narrow windows fit on one page), so hourly is about 24 requests a day per sindy against a budget as low as 250. Mitigations:
- Watched formats default to a narrow window: past 1 day, future 2 days. Email uses its own digest window.
- Before each watch, skip it if the last-seen `lowestRemaining` for that user is below a floor (e.g. 25), and record why. Stash `remaining` in KV per user from `postsForOutput`.
- Show on the edit page how many requests a day this sindy will spend.

**Later, not hackathon:** move delivery onto Cloudflare Queues for retries and backoff. For now, delivery is inline with try/catch, and the next tick does *not* resend events that failed to deliver. Accept that loss and show the error.

**Ask for the Buffer API team:** native webhooks (`post.sent`, `post.failed`) would replace polling here and make all of this real-time.

---

## Phase 1: Slack (incoming webhook)

**New files**
- `src/slack/message.ts`: pure. Turns `PostEvent[]` into Block Kit payloads, with `text` fallbacks so Discord and Mattermost render something sensible. Reuse `eventTitle`, `resolveChannel`, `serviceLabel` and `bufferPostUrl` from `src/present.ts`.
- `src/slack/send.ts`: POST to the webhook URL with a 5s timeout. A 404 or 410 means the webhook was revoked: mark the sindy errored and stop sending.

**Storage**: the webhook URL is a bearer secret. Seal it with `sealSecret` (`src/crypto.ts`) in a new table, so other formats can use it too:

```sql
-- Credentials for outbound destinations (Slack webhook URL, Micropub token, ...).
CREATE TABLE output_destinations (
  output_id   TEXT PRIMARY KEY REFERENCES outputs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,            -- 'slack_webhook' | 'micropub'
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  meta        TEXT,                     -- JSON, non-secret (endpoints, site URL, team name)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

**Settings** (store as a JSON column `destination_settings`, validated on read like `widget_style`):
- Event checkboxes: failed (on), needs approval (on), sent (on), scheduled/updated (off), upcoming (off, with a lead-time picker of 15/60 min).
- Optional daily "today's queue" summary at an hour in the user's timezone. It shares a renderer with the email digest (Phase 2).
- Webhook URL field: must be `https:`. Show the host back to the user ("posting to hooks.slack.com"), never the full URL after saving.

**Messages**
- Failed: `:warning: LinkedIn post failed: <error.message>`, with a link to `error.supportUrl` and the post in Buffer.
- Needs approval: batched per tick, "3 posts waiting for approval", listing each post.
- Sent: one message per cross-post group, reusing `groupPosts` from `src/atom/generate.ts`.

**Copy**: the edit page states plainly that this sindy will post drafts and scheduled content into a Slack channel, so the user should pick a channel accordingly.

**Tests**: `test/slack.test.ts`, covering payload snapshots per event type and the 404 handling.

### Phase 1b (stretch): full Slack app

- "Add to Slack" OAuth v2 with the `incoming-webhook` scope. Slack returns the webhook URL and channel name, so nobody pastes URLs. Needs `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` in `src/env.ts`. Reuse the KV-held state pattern from `src/routes/auth.tsx`.
- `/sindy today` slash command: `POST /slack/commands`, registered **above** the `csrf()` middleware in `src/index.tsx` (Slack posts cross-origin). Verify the `X-Slack-Signature` HMAC and reject timestamps older than 5 minutes. **Answer from the KV post cache only**; a slash command must never spend Buffer quota.
- Optional: add `author { name }` and `notes { text author { name } }` to `POST_FIELDS` so messages can say who scheduled a post and show its notes. Check that the read-only OAuth scopes grant these fields.

---

## Phase 2: WebSub (Atom, self-hosted hub)

**Discovery**
- `src/atom/generate.ts`: add `<link href="{appUrl}/websub" rel="hub"/>` next to the existing `rel="self"` link.
- `respondWithFeed` in `src/feed.ts`, Atom only: add `Link: <…/websub>; rel="hub", <…/feed/{token}.xml>; rel="self"` headers.

**Hub endpoint**: `POST /websub`, in a new `src/websub/hub.ts`, registered above `csrf()` like `/feed`.
- Form-encoded `hub.mode` (`subscribe` or `unsubscribe`), `hub.topic`, `hub.callback`, `hub.lease_seconds`, `hub.secret`.
- The topic must resolve to an Atom output on any of the three hosts (including the legacy ones). Look it up through `getOutputByToken`, or return 404 the same way `/feed` does.
- The callback must be `https:` and must not point at our own hosts. Clamp the lease to at most 10 days. Cap at 20 subscriptions per output.
- Return `202`, then verify intent in `waitUntil`: `GET callback?hub.mode=…&hub.topic=…&hub.challenge=<random>&hub.lease_seconds=…`. Store the subscription only if the response body echoes the challenge.

```sql
CREATE TABLE websub_subscriptions (
  id               TEXT PRIMARY KEY,
  output_id        TEXT NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  callback         TEXT NOT NULL,
  secret_cipher    TEXT,               -- sealed hub.secret, nullable per spec
  secret_iv        TEXT,
  lease_expires_at TEXT NOT NULL,
  failures         INTEGER NOT NULL DEFAULT 0,
  last_delivery_at TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (output_id, callback)
);
```

**Distribution**: a WebSub handler in `dispatch.ts`.
- Fires on `post.sent` (and on `post.updated` if the feed includes drafts).
- Rebuilds the feed with `buildFeed` (it reuses the cache) and POSTs the full Atom body to each live subscriber, with the same `Link` headers and `X-Hub-Signature: sha256=<HMAC(secret, body)>` when a secret is set.
- After 5 consecutive failures, or once the lease expires, the subscription is dropped.

**Lifecycle**
- `rotateFeedToken` must delete the output's subscriptions: the topic URL is the old token, so they would otherwise keep receiving content after the user revoked the URL. Add a test for this specifically.
- `deleteOutput` and `deleteUser` delete the table explicitly.
- Show "N live subscribers" on the Atom sindy page.

**Tests**: `test/websub.test.ts` (rejected topics and callbacks, the challenge echo, signature, rotation deleting subscriptions). Then run against websub.rocks's hub tests on a preview deploy.

---

## Phase 3: Micropub (PESOS to the user's own site)

**Connect flow**: `src/micropub/indieauth.ts` and new routes in `src/routes/micropub.tsx`.
1. The user enters their site URL. Fetch it with a timeout and size cap, and find `indieauth-metadata` (current spec) or the legacy `authorization_endpoint` / `token_endpoint`, plus `micropub`, from `Link` headers and `<link rel>`.
2. Authorization code + PKCE, using `createPkcePair` from the existing Buffer OAuth module and KV-held state. `client_id` is `APP_BASE_URL`. Serve a client metadata document (IndieAuth's client ID metadata) at a stable path so authorization servers can show the app name.
3. Scopes: `create media`, plus `update delete` only if the edit and delete step below is in scope.
4. Seal the token into `output_destinations` (`kind = 'micropub'`). Put `me`, the endpoints and the media endpoint (via `q=config`) in `meta`.

**Sync**: the Micropub handler in `dispatch.ts`, on `post.sent` only.
- Group cross-posts with `groupPosts`, so one group becomes one entry.
- `POST` JSON: `{ type: ['h-entry'], properties: { content, published, category: tags, photo: [asset.source …], 'post-status': ['draft'] } }`. Draft is the default, with a setting to publish directly.
- `photo` as a URL first. Fall back to the media endpoint upload only if the server rejects external URLs.
- Store the result so nothing is created twice:

```sql
CREATE TABLE micropub_entries (
  output_id    TEXT NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  group_key    TEXT NOT NULL,     -- groupPosts key, or post id when ungrouped
  location     TEXT NOT NULL,     -- Location header from the create response
  created_at   TEXT NOT NULL,
  PRIMARY KEY (output_id, group_key)
);
```

- No backfill: only posts sent after the connection is made.

**Known gap: `syndication` URLs.** Proper PESOS links each entry back to the live post on every network. Buffer's `Post` type has no permalink to the published post (`externalLink` is the link *inside* the post, and `Channel.externalLink` is the profile). For the hackathon, link to the channel profile and say so. This is the second ask for the Buffer API team: a `publishedUrl` on sent posts.

**Targets to test against**: micropub.rocks (conformance), WordPress with the IndieAuth and Micropub plugins, Micro.blog.

**Tests**: `test/micropub.test.ts`, covering endpoint discovery (headers, HTML, metadata), the payload for single and grouped posts, and the idempotency table.

---

## Phase 4: Email digest

**Sending**
- Through a provider HTTP API: Postmark, Resend or SES. New env vars `EMAIL_API_KEY` and `EMAIL_FROM`, sending from a subdomain with SPF/DKIM set up.
- Cloudflare's own `send_email` binding only delivers to verified destination addresses. That's fine for a demo sending to yourself, not for real recipients. Check whether Cloudflare's sending product has changed before deciding.

**Recipients**: double opt-in, because a form that emails arbitrary addresses is a spam relay.

```sql
CREATE TABLE digest_recipients (
  id                TEXT PRIMARY KEY,
  output_id         TEXT NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  confirm_token     TEXT,
  confirmed_at      TEXT,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  UNIQUE (output_id, email)
);
```

- The owner's Buffer account email is pre-confirmed. Anyone else gets a confirmation email first.
- `GET /digest/confirm/:token`, plus `GET` and `POST /digest/unsubscribe/:token`. The unsubscribe POST must sit **above** `csrf()`, because RFC 8058 one-click unsubscribe POSTs come from mail providers cross-origin.
- Every email sets `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.

**Schedule**: daily or weekly, at a day and hour in the user's timezone (`users.timezone`). Add an `outputs.next_digest_at` column, recomputed after each send. The watch query includes email outputs whose `next_digest_at` has passed. The email format doesn't need event detection: it renders a snapshot.

**Content**: `src/digest/render.ts`, pure, producing HTML and plain-text bodies from a post bundle. Sections: sent this period, scheduled next period, awaiting approval, failed. Shared with the Slack daily summary.

**Tests**: `test/digest.test.ts`, covering the render, the next-send calculation across DST, and the confirm/unsubscribe routes (including that the one-click POST works without an Origin header).

---

## Build order and rough sizing

| # | Work | Size | Unlocks |
|---|---|---|---|
| 1 | Format plumbing + audience table (0.1) | S | everything |
| 2 | Tag filter (0.2) | S | demo of "campaign → Slack channel" |
| 3 | Change-event engine + scheduler (0.3) | M | 4–7 |
| 4 | Slack incoming webhook (1) | S–M | the demo for Buffer people |
| 5 | WebSub hub (2) | M | the answer to "where are the webhooks" |
| 6 | Micropub (3) | M–L | the closing demo |
| 7 | Email digest (4) | M | stretch (sending setup is the fiddly part) |
| 8 | Slack app: OAuth + slash command (1b) | M | stretch |

Rough code footprint: about 6 new modules, 4 migrations, and new route groups `/websub`, `/micropub/*`, `/digest/*` (plus `/slack/*` if 1b). Changes to existing files are mostly confined to `src/index.tsx` (scheduler, route registration), `src/db.ts`, `src/routes/outputs.tsx` (format tables and settings forms), `src/buffer/client.ts` (tags), `src/atom/generate.ts` and `src/feed.ts` (hub links).

## Docs to update when it ships

- `PRODUCT.md` and `README.md`: new formats, the audience rule, quota cost of watched sindies.
- `src/routes/privacy.tsx`: new third parties (the Slack workspace, the email provider, the user's own site) and new stored data (recipient emails, sealed webhook URLs and tokens).
- `src/routes/faq.tsx`: "Why is Slack hourly at best?" (Buffer has no webhooks).

## Asks for the Buffer API team (worth raising at the hackathon)

1. Webhooks for post status changes, which would replace the whole polling engine.
2. A permalink to the published post (`publishedUrl`) on sent posts, for Micropub `syndication` and nicer Slack and email links.
3. A `sentAt` filter on `posts`. Today only `dueAt` and `createdAt` are filterable, so "everything sent since T" has to approximate with `dueAt`.

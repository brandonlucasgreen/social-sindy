# Social Sindy — Product

Turns your Buffer publishing schedule and history into subscribable feeds — calendar feeds (ICS) and content feeds (Atom/RSS) — from a single OAuth connection.

## What it does

You connect Buffer once. Then you create "sindies" — each sindy is either a calendar feed (ICS) that you subscribe to in Google Calendar, Apple Calendar, or Outlook, or a content feed (Atom/RSS) that you subscribe to in any RSS reader. Each sindy has its own channel selection, settings, and share URL. (`outputs` is the internal name, in the database table and route module; "sindy" is what the user sees.)

For ICS sindies, there's an optional Google Calendar push: instead of waiting for Google to re-fetch the ICS feed (which it does on its own 8–24 hour schedule), events are written directly into a dedicated Google calendar via the API. Changes appear within minutes. **This is built but currently disabled in the deployed app**, pending Google OAuth verification — see the section below.

## Who it's for

People who publish through Buffer and want their schedule and publishing history visible in the tools they already live in — their calendar, their RSS reader, their blog's feed — without manually copying things around.

## Principles

- **Honest about latency.** The ICS feed advertises its refresh interval. Google Calendar's 8–24 hour polling is acknowledged, not hidden. The push feature exists because it is the only way to make Google fast.
- **Never waste quota.** Buffer's API budget is small (as few as 250 requests/24h). Every feed response is cached within the refresh interval, so no volume of polling can drain a user's quota. The ICS feed and the Google push share a single Buffer fetch per interval.
- **Least privilege.** Buffer OAuth asks for `account:read`, `posts:read`, and `offline_access` only. Google OAuth asks for `calendar.app.created` only — it cannot see or touch existing calendars. The pasted-API-key path has been removed from the UI, because a personal key grants full account access including publishing; signing in with OAuth deletes any key an account still had stored.
- **Stale > empty.** A transient Buffer failure serves the last successful render rather than an empty feed, which clients would interpret as every event having been deleted.
- **Never publishes.** No post is created, edited, or deleted in the user's Buffer account. The tool is read-only.
- **One connection, multiple sindies.** A single Buffer OAuth connection can produce both ICS and Atom feeds. The user doesn't sign in twice or manage separate credentials.

## Formats

- **ICS** — iCalendar (RFC 5545). Subscribable by Google Calendar, Apple Calendar, Outlook, and any calendar client that supports subscription URLs. Each post becomes a calendar event at its scheduled or sent time.
- **Atom** — Atom Syndication Format (RFC 4287). Subscribable by any RSS reader. Each post becomes a feed entry with full text, channel metadata, and media attachments. Cross-posts can be grouped into a single entry.

## Optional Google Calendar push

ICS sindies can optionally push events directly into a dedicated Google calendar via the Calendar API. This makes changes appear within minutes instead of Google's 8–24 hour polling schedule. The push:

- Creates its own secondary calendar (never touches the user's primary or existing calendars)
- Only modifies events it created (tagged with a private extended property)
- Reconciles on each sync: creates new events, updates changed ones, removes deleted ones
- Runs on a cron that respects each sindy's own refresh interval

### Current status: off

`GOOGLE_CLIENT_ID` is commented out in `wrangler.toml`, so the feature is inert in production: the push UI is hidden, `/google/*` returns 501, and the cron finds nothing due. The reason is Google OAuth verification — until the `calendar.app.created` scope clears review, the consent screen stays in Testing, where Google expires refresh tokens after 7 days. A push that silently breaks every week is worse than no push. The code and tests stay in place; re-enabling is uncommenting one line. See `docs/google-verification.md`.

## Naming

The product is called **social sindy**. The primary domain is `socialsindy.com`. Two older hostnames, `social-sindy.bgreen.lol` and `social-cally.bgreen.lol`, stay routed so existing subscribers' feed URLs keep working — they are compatibility, not names.

The hyphenated `social-sindy` is the identifier everywhere one is needed: package name, Worker name, D1 database name, and ICS UID domain. The spaced `social sindy` appears in the UI, page titles, and privacy policy. The project's earlier calendars-only name is retired and should not appear in code, config, or copy.

"Sindy" is a syndication pun — **S**yndication + **Indy** (independent).
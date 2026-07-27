# Social Sindy — Product

Turns your Buffer publishing schedule and history into subscribable feeds — calendar feeds (ICS) and content feeds (Atom/RSS) — from a single OAuth connection.

## What it does

You connect Buffer once. Then you create "outputs" — each output is either a calendar feed (ICS) that you subscribe to in Google Calendar, Apple Calendar, or Outlook, or a content feed (Atom/RSS) that you subscribe to in any RSS reader. Each output has its own channel selection, settings, and share URL.

For ICS outputs, there's an optional Google Calendar push: instead of waiting for Google to re-fetch the ICS feed (which it does on its own 8–24 hour schedule), events are written directly into a dedicated Google calendar via the API. Changes appear within minutes.

## Who it's for

People who publish through Buffer and want their schedule and publishing history visible in the tools they already live in — their calendar, their RSS reader, their blog's feed — without manually copying things around.

## Principles

- **Honest about latency.** The ICS feed advertises its refresh interval. Google Calendar's 8–24 hour polling is acknowledged, not hidden. The push feature exists because it is the only way to make Google fast.
- **Never waste quota.** Buffer's API budget is small (as few as 250 requests/24h). Every feed response is cached within the refresh interval, so no volume of polling can drain a user's quota. The ICS feed and the Google push share a single Buffer fetch per interval.
- **Least privilege.** Buffer OAuth asks for `account:read` and `posts:read` only. Google OAuth asks for `calendar.app.created` only — it cannot see or touch existing calendars. A pasted API key works but is discouraged because it grants full access.
- **Stale > empty.** A transient Buffer failure serves the last successful render rather than an empty feed, which clients would interpret as every event having been deleted.
- **Never publishes.** No post is created, edited, or deleted in the user's Buffer account. The tool is read-only.
- **One connection, multiple outputs.** A single Buffer OAuth connection can produce both ICS and Atom feeds. The user doesn't sign in twice or manage separate credentials.

## Formats

- **ICS** — iCalendar (RFC 5545). Subscribable by Google Calendar, Apple Calendar, Outlook, and any calendar client that supports subscription URLs. Each post becomes a calendar event at its scheduled or sent time.
- **Atom** — Atom Syndication Format (RFC 4287). Subscribable by any RSS reader. Each post becomes a feed entry with full text, channel metadata, and media attachments. Cross-posts can be grouped into a single entry.

## Optional Google Calendar push

ICS outputs can optionally push events directly into a dedicated Google calendar via the Calendar API. This makes changes appear within minutes instead of Google's 8–24 hour polling schedule. The push:

- Creates its own secondary calendar (never touches the user's primary or existing calendars)
- Only modifies events it created (tagged with a private extended property)
- Reconciles on each sync: creates new events, updates changed ones, removes deleted ones
- Runs on a cron that respects each output's own refresh interval

## Naming

The product is called **social sindy**. The domain is `social-sindy.bgreen.lol`. The hyphenated `social-sindy` appears in the package name, Worker name, D1 database name, and ICS UID domain. The spaced `social sindy` appears in the UI, page titles, and privacy policy.

"Sindy" is a syndication pun — **S**yndication + **Indy** (independent).
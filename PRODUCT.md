# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Buffer users who schedule social posts and want their publishing schedule visible
in the calendar they already live in. Primary audience is individual creators and
social media managers on Buffer.

Publicly available: any Buffer user can sign in. Visitors arrive cold, with no
prior trust, and must decide whether to grant OAuth access to their Buffer
account. The connect step therefore has to explain what the tool does, what it
can see, and why that is safe — it cannot assume familiarity.

## Product Purpose

Turns a Buffer publishing schedule into a calendar. The user connects Buffer,
picks an organization and channels, and gets a subscribable calendar feed; each
scheduled post appears as an event.

Success is a user who subscribes once and then sees their queue in their own
calendar, staying in sync without further attention.

## Positioning

Buffer has no first-party calendar export. The mechanism is read-only access to
the posting schedule, rendered two ways: a standards-compliant iCalendar feed
that any calendar app can subscribe to, and (planned) a direct Google Calendar
API push for users who need changes to land in Google within minutes.

The differentiator is honesty about sync latency. A subscribed ICS feed cannot
update Google quickly, and the product says so plainly rather than implying
control it does not have.

## Operating Context

Users work inside Buffer's own publishing calendar but plan their days in a
separate work calendar; the point of the tool is to stop switching between them.
Target calendar clients are Google Calendar, Apple Calendar/iCloud, and Outlook —
each with different refresh behaviour that the product has to account for.

## Capabilities and Constraints

- Buffer's public GraphQL API (`api.buffer.com`). Rate limits are scoped per
  credential and small — as few as 100 requests/15 min, 250/24 h, 3,000/30 days —
  which dictates aggressive caching throughout.
- Buffer OAuth (authorization code + PKCE) requires a public HTTPS redirect URI,
  so OAuth only works once hosted. Pasting a personal API key is the interim.
- Planned Google Calendar push requests only the `calendar.app.created` scope, so
  the tool can never see calendars it did not create.
- Cloudflare Workers, D1, and KV. Server-rendered pages, no client-side
  framework.
- Feed URLs must be unauthenticated, because calendar clients cannot send
  credentials. The unguessable token in the URL is the only protection, and it is
  rotatable.
- An iCalendar feed is the universal mechanism; every target client accepts one.
  Serving CalDAV is explicitly out of scope — Google Calendar cannot consume it
  and Apple does not need it.
- Undecided: the production hostname, and whether a Stolzl licence is available.

## Brand Commitments

Named social-cally. Deliberately **brand-adjacent and clearly third-party**: it may
use Buffer's colour, type, shape, and shadow language so it feels native to the
ecosystem, but must not use the Buffer logo or wordmark, and must carry an honest
signal that it is unofficial. A third-party tool that holds other people's OAuth
tokens while presenting itself as first-party would be a trust problem.

## Evidence on Hand

- Buffer's public design tokens, read from buffer.com: `Figtree` (body) and
  `Stolzl` (headings, proprietary), the brand palette, fluid type and space
  scales, radii, shadows, and per-network brand colours.
- Real scheduled and published posts from a live Buffer account, used verbatim as
  test fixtures (`test/ics-roundtrip.test.ts`).
- No testimonials, user counts, customer logos, uptime figures, or pricing exist.
  Future work must not invent any.

## Product Principles

1. **Be honest about latency.** Never imply a refresh guarantee the underlying
   calendar client does not honour.
2. **Never waste a user's Buffer quota.** Their limits are small and shared with
   everything else they use.
3. **Least privilege on every credential.** Request the narrowest scope that
   works, and prefer revocable tokens over long-lived keys.
4. **A failure must never look like data loss.** Serve stale rather than empty.
5. **The user's calendar is their space.** Only ever touch events this tool
   created.

## Accessibility & Inclusion

Honour the visitor's system colour scheme in both directions. Every control
keyboard-operable with a visible focus indicator. Channel identity must never be
carried by colour alone, since the picker distinguishes many similar networks.

# Google OAuth verification

Notes for submitting social-cally for verification of the
`calendar.app.created` scope. Kept because verification recurs — a scope change
or a new domain re-triggers it, and none of this is worth rediscovering.

## The good news: sensitive, not restricted

`https://www.googleapis.com/auth/calendar.app.created` is a **sensitive** scope.
Sensitive scopes need verification — brand review, a demo video, a scope
justification, domain ownership. They do **not** need the third-party security
assessment (CASA) that **restricted** scopes require, which is the expensive one
involving a pentest and an annual fee. Gmail and Drive-content scopes are
restricted; Calendar is not.

Choosing `calendar.app.created` over `calendar` or `calendar.events` is what
keeps us on the cheap side of that line, on top of being the right least
privilege. Do not widen the scope casually — it changes the review category.

## What the reviewer checks

| Requirement | Value |
| --- | --- |
| App home page | `https://social-cally.bgreen.lol` |
| Privacy policy | `https://social-cally.bgreen.lol/privacy` |
| Authorized domain | `bgreen.lol` |
| Redirect URI | `https://social-cally.bgreen.lol/google/callback` |
| Logo | `assets/mark-120.png` (120×120; `mark-120-white.png` if transparency is refused) |

All must be live and publicly reachable **at submission time** — the reviewer
fetches them. A privacy policy change that is committed but not deployed reads
as a missing privacy policy.

Two things that are easy to miss:

- **Domain ownership must be verified in Google Search Console**, for
  `bgreen.lol`, under the *same* Google account that owns the Cloud project.
  Without it the authorized domain is rejected.
- **The Limited Use disclosure** must appear in the privacy policy, in Google's
  own wording. Ours is in `src/routes/privacy.tsx`; it uses the prescribed
  sentence verbatim because reviewers look for that phrasing rather than an
  equivalent paraphrase. Its absence is the most common first-submission
  rejection.

## Scope justification

Paste something close to this, adjusting for tone:

> social-cally turns a user's Buffer publishing schedule into a calendar. The
> optional Google Calendar sync creates one new secondary calendar in the user's
> account and writes their scheduled social posts into it as events, so changes
> appear within minutes rather than on the multi-hour cycle an ICS subscription
> allows.
>
> `calendar.app.created` is requested because it is the narrowest scope that
> permits this: it grants access only to calendars the application itself
> created. The application cannot see, read, or modify any pre-existing
> calendar, including the user's primary calendar. The broader `calendar` and
> `calendar.events` scopes would grant access to everything the user owns, which
> this feature does not need and users should not have to grant.
>
> Events written by the application are tagged with a private extended property
> and reconciliation filters on it, so the sync can only ever modify or delete
> events it created — an event the user adds to that calendar by hand is
> invisible to it and is never touched.
>
> The sync is optional and off by default. The core product, a subscribable ICS
> feed, works without any Google access at all.

## Demo video

Unlisted YouTube is fine. Reviewers want to see the real consent screen and the
data actually being used. Cover, in order:

1. The app home page at the verified domain, showing what it is.
2. Signing in, then enabling Google sync — the **full consent screen**, legible,
   showing the exact scope being requested.
3. What the granted access does: the created calendar appearing in Google
   Calendar with posts in it.
4. That it is scoped — the user's other calendars are untouched.

Narrate why the scope is needed. Reviews stall on videos that show the app but
never show the consent screen.

## While unverified

The consent screen stays in *Testing*, where **refresh tokens expire after 7
days**. The push therefore breaks weekly for every test user, including the
operator. This is the publishing status, not a bug — do not debug it. Up to 100
test users can be added in the meantime.

Consequence: the push cannot be offered to the public until verification clears,
however finished the code is.

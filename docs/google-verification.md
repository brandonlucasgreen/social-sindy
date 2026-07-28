# Google OAuth verification

Notes for submitting social sindy for verification of the
`calendar.app.created` scope. Kept because verification recurs — a scope change
or a new domain re-triggers it, and none of this is worth rediscovering.

The values below are the current ones, on `socialsindy.com`. An earlier draft of
this doc used the project's previous domain; if a half-finished submission in the
Google Cloud console still carries those, update it before resubmitting, because
the reviewer checks that every URL is live.

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

## What you are actually asking for

Not identity verification, and not a code audit. You are asking Google to let
this app request a sensitive scope **from people who are not you**.

Unverified, the app is capped at *Testing*: up to 100 named test users, a
full-page "Google hasn't verified this app" warning before consent, and refresh
tokens that die after 7 days. Verified, it moves to *In production*: anyone can
connect, the warning goes away, and tokens stop expiring on a timer.

So the review is Google satisfying itself of four things:

1. **You control the domain** the app runs on and the policy is hosted at.
2. **The app is what it says it is** — name and logo not impersonating anyone,
   home page describing the actual product.
3. **The scope is justified by real functionality** they can see working.
4. **Your privacy policy discloses the data handling** and commits to Limited
   Use.

Everything below is in service of those four.

## Where the settings actually live

Google moved this out of "APIs & Services → OAuth consent screen" into a
section called **Google Auth Platform**. Labels shift; the structure has been
stable:

| Tab | What is set there |
| --- | --- |
| **Branding** | App name, logo, home page, privacy policy URL, authorized domains, support email |
| **Audience** | Testing vs Production, test users, and the **Publish app** button that starts verification |
| **Clients** | The OAuth client ID and its redirect URIs |
| **Data Access** | Which scopes are requested, and the justification for each |
| **Verification Center** | Submission status, demo video, reviewer correspondence |

Order that works, because later steps reject unless earlier ones are done:

1. **Search Console first** — verify `bgreen.lol` at
   `search.google.com/search-console`, signed in as the *same* Google account
   that owns the Cloud project. Nothing else will accept the domain until this
   exists.
2. **Branding** — fill everything, including the authorized domain.
3. **Data Access** — confirm `calendar.app.created` is listed, paste the
   justification below.
4. **Audience → Publish app** — flips Testing to "in production, pending
   verification" and opens the request.
5. **Verification Center** — attach the demo video, then wait. Expect
   correspondence rather than a single verdict; reviewers routinely come back
   once asking for a clearer video or a tightened justification.

The app keeps working for test users throughout.

## What the reviewer checks

| Requirement | Value |
| --- | --- |
| App home page | `https://socialsindy.com` |
| Privacy policy | `https://socialsindy.com/privacy` |
| Authorized domain | `socialsindy.com` |
| Redirect URI | `https://socialsindy.com/google/callback` |
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

> social sindy turns a user's Buffer publishing schedule into a calendar. The
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

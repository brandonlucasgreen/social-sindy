/**
 * Privacy policy.
 *
 * Written against what the code actually does. Every claim here is checkable
 * against a specific file, and the retention periods are the real TTLs. Two
 * things are deliberately left as bracketed placeholders rather than invented:
 * who operates the deployment, and the contact address.
 */

import { Hono } from 'hono';

import { Layout, Notice } from '../ui/layout.jsx';
import type { AppBindings } from '../session.js';

export const privacyRoutes = new Hono<AppBindings>();

/**
 * Bumped whenever the substance changes, so the page can state honestly when it
 * was last revised.
 */
const LAST_UPDATED = '26 July 2026';

privacyRoutes.get('/privacy', (c) =>
  c.html(
    <Layout title="Privacy policy — buffer-cally" user={c.get('user')} narrow>
      <h1>Privacy policy</h1>
      <p class="lede">
        What buffer-cally stores, why, for how long, and who else sees it. Last updated{' '}
        {LAST_UPDATED}.
      </p>

      <Notice>
        <p>
          <strong>The short version.</strong> This tool reads your Buffer posting schedule and turns
          it into a calendar. It stores your Buffer credential encrypted, caches your posts briefly
          so it does not exhaust your Buffer API quota, and never publishes anything, sells anything,
          or runs analytics or advertising. Deleting your account erases everything it holds.
        </p>
      </Notice>

      <h2>Who runs this</h2>
      <p>
        buffer-cally is an independent tool. It is not made by, affiliated with, or endorsed by
        Buffer or Google. This deployment is operated by <strong>[operator name]</strong>, who is
        responsible for the data described below. Questions go to{' '}
        <strong>[contact email]</strong>.
      </p>

      <h2>What it stores</h2>
      <p>Only what is needed to build your calendar:</p>
      <ul>
        <li>
          <strong>Your Buffer account details</strong> — account ID, email address, name, and time
          zone, as returned by Buffer when you connect. The email identifies your account here and
          is shown to you when signed in.
        </li>
        <li>
          <strong>Your Buffer credential</strong> — encrypted with AES-256-GCM before it is written
          to the database, using a key held only in this deployment's server secrets. It is never
          written to logs, never shown back to you, and never sent anywhere except Buffer's own API.
        </li>
        <li>
          <strong>Your calendar settings</strong> — which organization and channels you chose, the
          event length, refresh interval, date window, and which post statuses to include.
        </li>
        <li>
          <strong>A session cookie</strong> — a random identifier that keeps you signed in for 30
          days. It is not used for tracking and carries no personal data.
        </li>
        <li>
          <strong>Sync bookkeeping</strong> — timestamps of the last fetch, how many events were
          produced, and any error message, so the dashboard can show whether syncing works.
        </li>
      </ul>

      <h2>Your post content</h2>
      <p>
        Building a calendar means handling the text of your scheduled posts. Post content is{' '}
        <strong>cached, not permanently stored</strong>:
      </p>
      <ul>
        <li>
          Fetched posts and the rendered calendar are held in a temporary cache for at most your
          chosen refresh interval, so that repeated polling by your calendar app does not exhaust
          your Buffer API quota.
        </li>
        <li>
          One most-recent successful calendar is kept for up to <strong>7 days</strong> as a
          fallback. If Buffer is unreachable, that copy is served instead of an empty calendar —
          without it, your calendar app would interpret the gap as every event having been deleted.
        </li>
        <li>Nothing else retains post content, and it is never written to logs.</li>
      </ul>

      <h2>Your calendar feed URL is public</h2>
      <p>
        This is the most important thing to understand. Calendar apps cannot send a password when
        they fetch a subscription, so the feed URL has to work without one. It contains a long
        random token instead, which is the only thing protecting it.
      </p>
      <p>
        <strong>Anyone who has that URL can read the posts in that calendar.</strong> Treat it like a
        password: do not post it publicly or paste it into a shared document. If it leaks, use
        “Replace URL” on the calendar page — the old URL stops working immediately. Feed responses
        are served with <code>noindex</code> and no referrer, so search engines will not index them
        and the URL is not leaked to sites you visit.
      </p>

      <h2>Google Calendar sync, if you enable it</h2>
      <p>
        Connecting Google is optional and off by default. If you turn it on:
      </p>
      <ul>
        <li>
          The only permission requested is <code>calendar.app.created</code>, which allows creating
          a calendar and managing events <em>on calendars this tool created</em>. It cannot see, read,
          or change your existing calendars, including your primary one.
        </li>
        <li>
          A Google refresh token is stored, encrypted the same way as your Buffer credential, plus
          the email address of the Google account and the identifier of the calendar created for you.
        </li>
        <li>
          Only events created by this tool are ever modified or deleted. Events you add to that
          calendar yourself are invisible to the sync and are never touched.
        </li>
        <li>
          Disconnecting Google, or turning push off, erases the stored token and stops all syncing.
          The Google calendar and its events are left in place for you to keep or delete — removing
          a calendar from your account is not a decision this tool makes for you.
        </li>
      </ul>

      <h2>Who else sees your data</h2>
      <ul>
        <li>
          <strong>Buffer</strong> — every request for your schedule goes to Buffer's API using your
          own credential, and is subject to Buffer's privacy policy.
        </li>
        <li>
          <strong>Cloudflare</strong> — this tool runs on Cloudflare Workers, with data in
          Cloudflare D1 and KV. Cloudflare processes requests and stores this data on the operator's
          behalf, and records standard request logs including IP addresses.
        </li>
        <li>
          <strong>Google</strong> — only if you enable Calendar sync, and only for the calendar this
          tool creates.
        </li>
        <li>
          <strong>Google Fonts</strong> — pages load the Figtree typeface from{' '}
          <code>fonts.googleapis.com</code>, which means your browser contacts Google and reveals
          your IP address when you load a page. Nothing else about you is sent, and this happens on
          the interface pages only, never on the calendar feed itself.
        </li>
      </ul>
      <p>
        There are no analytics, no advertising, no third-party trackers, and no other embedded
        services. Your data is never sold or shared for marketing.
      </p>

      <h2>Deleting your data</h2>
      <p>
        “Delete account and stored key” on your calendars page erases your account record, your
        encrypted Buffer credential, any Google credential, every calendar you created here, and all
        associated sessions. Feed URLs stop working immediately. Cached copies expire on their own
        within 7 days at the latest.
      </p>
      <p>
        Deleting your account here does not touch anything in Buffer. To revoke this tool's access
        from Buffer's side, delete the API key in{' '}
        <a href="https://publish.buffer.com/settings/api" target="_blank" rel="noreferrer noopener">
          Buffer → Settings → API
        </a>
        . To revoke Google access, use your{' '}
        <a
          href="https://myaccount.google.com/permissions"
          target="_blank"
          rel="noreferrer noopener"
        >
          Google account permissions
        </a>
        .
      </p>

      <h2>Security</h2>
      <p>
        Credentials are encrypted at rest with AES-256-GCM, which also detects tampering. The
        encryption key lives in server secrets, never in the database or the source code. Session
        cookies are <code>HttpOnly</code> and <code>SameSite=Lax</code>, and marked{' '}
        <code>Secure</code> over HTTPS. Form submissions are checked against their origin. No
        credential is ever logged.
      </p>
      <p>
        No system is perfectly secure, and a Buffer API key grants broad access to your Buffer
        account. If that concerns you, that is a reasonable position — the connect page says so too.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes in a way that affects what is collected or who sees it, the date at
        the top of this page changes with it.
      </p>

      <p class="small" style="margin-top:2rem">
        This document describes what the software does. It is not legal advice, and it is not a
        contract.
      </p>
    </Layout>,
  ),
);

/**
 * Terms of service.
 *
 * Companion to the privacy policy: that page covers what social sindy stores
 * and why; this one covers the terms under which you may use it. Written in
 * the same plain, checkable style — every claim here should stay true to what
 * the code actually does, not read as boilerplate borrowed from elsewhere.
 *
 * Drafted by engineering, not a lawyer, and reviewed and approved by the
 * operator before being wired in — see the closing paragraph on the page
 * itself.
 */

import { Hono } from 'hono';

import { appOrigin } from '../env.js';
import { Layout } from '../ui/layout.jsx';
import type { AppBindings } from '../session.js';

export const tosRoutes = new Hono<AppBindings>();

/** Bumped whenever the substance changes, matching the pattern in privacy.tsx. */
const LAST_UPDATED = '28 July 2026';

tosRoutes.get('/terms', (c) =>
  c.html(
    <Layout
      title="Terms of service — social sindy"
      description="The terms under which you may use social sindy: what it is, what it isn't, acceptable use, and what happens if either of us stops using it."
      canonical={`${appOrigin(c.env)}/terms`}
      indexable
      user={c.get('user')}
      narrow
    >
      <h1>Terms of service</h1>
      <p class="lede">
        The terms under which you may use social sindy. Last updated {LAST_UPDATED}.
      </p>

      <h2>What this is</h2>
      <p>
        social sindy is a free, independent tool that connects to your Buffer account with
        read-only access and turns your publishing schedule into a calendar feed (ICS) and a
        content feed (Atom/RSS). It is not made by, affiliated with, or endorsed by Buffer or
        Google — see the <a href="/privacy">privacy policy</a> for exactly what it stores. By
        connecting your Buffer account, you agree to these terms.
      </p>

      <h2>Your account and your content</h2>
      <ul>
        <li>
          You need your own Buffer account in good standing to connect. social sindy does not
          create, sell, or manage Buffer accounts, and has no relationship with Buffer on your
          behalf.
        </li>
        <li>
          You're responsible for the organization and channels you choose to connect, and for
          anything published through them — this tool only reads; it never posts, edits, or
          deletes anything in Buffer on your behalf.
        </li>
        <li>
          Your feed URL is unguessable but not secret once shared — anyone who has it can read
          it. You're responsible for keeping your own feed URL as private as you'd keep a
          password. If it leaks, replace it from your calendars page; the old one stops working
          immediately.
        </li>
      </ul>

      <h2>Acceptable use</h2>
      <p>Please don't:</p>
      <ul>
        <li>Try to guess, enumerate, share, or publish someone else's feed URL.</li>
        <li>
          Poll a feed URL far more often than a calendar or RSS client normally would, or
          otherwise try to use the service in a way that degrades it for other users.
        </li>
        <li>Use social sindy to violate Buffer's or Google's own terms of service.</li>
        <li>Probe, disable, or attempt to circumvent any security control on this site.</li>
      </ul>
      <p>An account or feed token involved in abuse may be disabled without notice.</p>

      <h2>No warranty</h2>
      <p>
        social sindy is provided <strong>"as is,"</strong> with no warranty of any kind, express
        or implied — including no warranty that it will be available, accurate, uninterrupted, or
        free of errors. It's a free, solo-maintained tool, not a commercial product sold with an
        uptime guarantee.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the fullest extent the law allows, social sindy and its operator aren't liable for any
        indirect, incidental, or consequential damages arising from your use of, or inability to
        use, the service — including a missed post, a stale calendar, or a feed that stops
        working. Your Buffer account, your Buffer posts, and your Buffer API quota remain yours
        and Buffer's responsibility, not this tool's.
      </p>

      <h2>Changes and termination</h2>
      <ul>
        <li>
          You can stop using social sindy at any time. "Delete account and stored key" on your
          calendars page erases everything it holds — see the{' '}
          <a href="/privacy">privacy policy</a> for exactly what that means.
        </li>
        <li>
          This service may change, or be discontinued, at any time. If it's ever shut down
          entirely, existing feed URLs will stop resolving.
        </li>
        <li>
          These terms may change as the service changes. Continuing to use social sindy after a
          change means you accept the new terms; the date at the top of this page reflects any
          substantive one.
        </li>
      </ul>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of the Commonwealth of Massachusetts, USA, without
        regard to conflict-of-law principles.
      </p>

      <p class="small" style="margin-top:2rem">
        This document describes the terms under which the software may be used. It's drafted by
        the operator, not a lawyer, and shouldn't be treated as a substitute for legal advice.
      </p>
    </Layout>,
  ),
);

/**
 * social-cally — turns a Buffer publishing schedule into a calendar.
 *
 * Route groups:
 *   /                   connect Buffer (also signs in)
 *   /calendars/*        create and manage calendars
 *   /google/*           connect Google and drive the optional push
 *   /privacy            privacy policy
 *   /feed/:token.ics    the public feed calendar clients poll
 *
 * Also exports a `scheduled` handler, which is what makes the Google push
 * timely — the one thing a subscribed ICS feed cannot be.
 */

import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';

import { calendarsDueForPush, getCalendarByToken } from './db.js';
import type { Env } from './env.js';
import { respondWithFeed } from './feed.js';
import { authRoutes } from './routes/auth.jsx';
import { calendarRoutes } from './routes/calendars.jsx';
import { googleRoutes } from './routes/google.jsx';
import { privacyRoutes } from './routes/privacy.jsx';
import { withUser, type AppBindings } from './session.js';
import { pushCalendar } from './sync/push.js';
import { Layout, Notice } from './ui/layout.jsx';
import { MARK_SVG } from './ui/mark.jsx';

const app = new Hono<AppBindings>();

/**
 * The feed is registered first and deliberately outside the session and CSRF
 * middleware: calendar clients send no cookies and no Origin header, and this
 * route must stay a plain, cheap GET.
 */
app.on(['GET', 'HEAD'], '/feed/:file', async (c) => {
  const file = c.req.param('file');
  if (!file.endsWith('.ics')) return c.notFound();

  const token = file.slice(0, -'.ics'.length);
  const calendar = await getCalendarByToken(c.env.DB, token);

  // Same response for a malformed token and a deleted calendar, so the endpoint
  // does not confirm which tokens ever existed.
  if (!calendar) {
    return c.text('This calendar feed does not exist.\n', 404, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }

  return respondWithFeed(c.env, calendar, c.req.raw, {
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });
});

app.get('/healthz', (c) => c.text('ok'));

/**
 * Favicon. Registered above the CSRF and session middleware because it is a
 * public static asset — a browser fetches it without a session, and there is
 * nothing here worth a cookie lookup.
 */
app.get('/icon.svg', (c) =>
  c.body(MARK_SVG, 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'public, max-age=86400',
  }),
);

/**
 * Rejects cross-origin form posts. Calendar feeds are read-only GETs, so this
 * applies only to the authenticated management UI.
 */
app.use('*', csrf());
app.use('*', withUser);

app.route('/', privacyRoutes);
app.route('/', authRoutes);
app.route('/', calendarRoutes);
app.route('/', googleRoutes);

app.notFound((c) =>
  c.html(
    <Layout title="Not found — social cally" user={c.get('user')}>
      <h1>Not found</h1>
      <p>
        <a href="/">Back to the start</a>
      </p>
    </Layout>,
    404,
  ),
);

app.onError((error, c) => {
  // Deliberate HTTP failures — a rejected cross-origin post, for instance —
  // already carry the right status, and must not be flattened into a 500.
  if (error instanceof HTTPException) {
    return c.html(
      <Layout title="Request blocked — social cally" user={c.get('user')}>
        <h1>Request blocked</h1>
        <Notice kind="error">
          {error.status === 403
            ? 'That form submission did not come from this site, so it was rejected. Please try again from the page itself.'
            : error.message || 'That request could not be completed.'}
        </Notice>
        <p>
          <a href="/calendars">Back to your calendars</a>
        </p>
      </Layout>,
      error.status,
    );
  }

  // Log for the operator; never surface internals, which could include details
  // about a stored credential.
  console.error('unhandled error', error);

  return c.html(
    <Layout title="Something went wrong — social cally" user={c.get('user')}>
      <h1>Something went wrong</h1>
      <Notice kind="error">
        That request could not be completed. If it keeps happening, disconnect and reconnect your
        Buffer key.
      </Notice>
      <p>
        <a href="/calendars">Back to your calendars</a>
      </p>
    </Layout>,
    500,
  );
});

/**
 * Most calendars a single tick can sync.
 *
 * A cron invocation has a bounded CPU budget, and each calendar costs several
 * Google calls. Anything not reached is picked up on the next tick, since the
 * query orders by least-recently-pushed.
 */
const MAX_CALENDARS_PER_TICK = 20;

/**
 * Scheduled push.
 *
 * The cron fires on a fixed short interval; each calendar's own refresh setting
 * decides whether it is actually due, so a once-a-day calendar is not synced
 * every tick. One calendar failing must not stop the others, so failures are
 * logged and recorded against that calendar rather than thrown.
 */
async function scheduled(_event: ScheduledController, env: Env): Promise<void> {
  const due = await calendarsDueForPush(env.DB, new Date(), MAX_CALENDARS_PER_TICK);
  if (!due.length) return;

  console.log(`push tick: ${due.length} calendar(s) due`);

  for (const calendar of due) {
    try {
      const outcome = await pushCalendar(env, calendar);
      if (!outcome.noop) {
        console.log(
          `pushed calendar=${calendar.id} +${outcome.stats.created} ~${outcome.stats.updated} -${outcome.stats.deleted}`,
        );
      }
    } catch (error) {
      console.error(`push failed calendar=${calendar.id}`, error);
    }
  }
}

export default { fetch: app.fetch, scheduled };

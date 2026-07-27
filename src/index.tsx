/**
 * social-sindy — turns a Buffer publishing schedule and history into
 * subscribable feeds: calendar feeds (ICS) and content feeds (Atom/RSS),
 * from a single OAuth connection.
 *
 * Route groups:
 *   /                   connect Buffer (also signs in)
 *   /sindies/*          create and manage sindies (ICS or Atom)
 *   /google/*           connect Google and drive the optional push (ICS only)
 *   /privacy            privacy policy
 *   /feed/:token.ics    the public ICS feed calendar clients poll
 *   /feed/:token.xml    the public Atom feed RSS readers poll
 *
 * Also exports a `scheduled` handler, which is what makes the Google push
 * timely — the one thing a subscribed ICS feed cannot be.
 */

import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';

import { getOutputByToken, outputsDueForPush } from './db.js';
import type { Env } from './env.js';
import { respondWithFeed } from './feed.js';
import { authRoutes } from './routes/auth.jsx';
import { outputRoutes } from './routes/outputs.jsx';
import { faqRoutes } from './routes/faq.jsx';
import { googleRoutes } from './routes/google.jsx';
import { privacyRoutes } from './routes/privacy.jsx';
import { withUser, type AppBindings } from './session.js';
import { pushOutput } from './sync/push.js';
import { Layout, Notice } from './ui/layout.jsx';
import { MARK_SVG } from './ui/mark.jsx';

const app = new Hono<AppBindings>();

/**
 * The feed is registered first and deliberately outside the session and CSRF
 * middleware: calendar clients and RSS readers send no cookies and no Origin
 * header, and this route must stay a plain, cheap GET.
 */
app.on(['GET', 'HEAD'], '/feed/:file', async (c) => {
  const file = c.req.param('file');

  let token: string | null = null;
  if (file.endsWith('.ics')) {
    token = file.slice(0, -'.ics'.length);
  } else if (file.endsWith('.xml')) {
    token = file.slice(0, -'.xml'.length);
  } else {
    return c.notFound();
  }

  const output = await getOutputByToken(c.env.DB, token);

  // Same response for a malformed token and a deleted output, so the endpoint
  // does not confirm which tokens ever existed.
  if (!output) {
    return c.text('This feed does not exist.\n', 404, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }

  return respondWithFeed(c.env, output, c.req.raw, {
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
 * Rejects cross-origin form posts. Feeds are read-only GETs, so this
 * applies only to the authenticated management UI.
 */
app.use('*', csrf());
app.use('*', withUser);

app.route('/', privacyRoutes);
app.route('/', authRoutes);
app.route('/', faqRoutes);
app.route('/', outputRoutes);
app.route('/', googleRoutes);

app.notFound((c) =>
  c.html(
    <Layout title="Not found — social sindy" user={c.get('user')}>
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
      <Layout title="Request blocked — social sindy" user={c.get('user')}>
        <h1>Request blocked</h1>
        <Notice kind="error">
          {error.status === 403
            ? 'That form submission did not come from this site, so it was rejected. Please try again from the page itself.'
            : error.message || 'That request could not be completed.'}
        </Notice>
        <p>
          <a href="/sindies">Back to your sindies</a>
        </p>
      </Layout>,
      error.status,
    );
  }

  // Log for the operator; never surface internals, which could include details
  // about a stored credential.
  console.error('unhandled error', error);

  return c.html(
    <Layout title="Something went wrong — social sindy" user={c.get('user')}>
      <h1>Something went wrong</h1>
      <Notice kind="error">
        That request could not be completed. If it keeps happening, disconnect and reconnect your
        Buffer key.
      </Notice>
      <p>
        <a href="/sindies">Back to your sindies</a>
      </p>
    </Layout>,
    500,
  );
});

/**
 * Most outputs a single tick can sync.
 *
 * A cron invocation has a bounded CPU budget, and each output costs several
 * Google calls. Anything not reached is picked up on the next tick, since the
 * query orders by least-recently-pushed.
 */
const MAX_OUTPUTS_PER_TICK = 20;

/**
 * Scheduled push.
 *
 * The cron fires on a fixed short interval; each output's own refresh setting
 * decides whether it is actually due, so a once-a-day output is not synced
 * every tick. One output failing must not stop the others, so failures are
 * logged and recorded against that output rather than thrown.
 */
async function scheduled(_event: ScheduledController, env: Env): Promise<void> {
  const due = await outputsDueForPush(env.DB, new Date(), MAX_OUTPUTS_PER_TICK);
  if (!due.length) return;

  console.log(`push tick: ${due.length} output(s) due`);

  for (const output of due) {
    try {
      const outcome = await pushOutput(env, output);
      if (!outcome.noop) {
        console.log(
          `pushed output=${output.id} +${outcome.stats.created} ~${outcome.stats.updated} -${outcome.stats.deleted}`,
        );
      }
    } catch (error) {
      console.error(`push failed output=${output.id}`, error);
    }
  }
}

export default { fetch: app.fetch, scheduled };
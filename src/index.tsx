/**
 * buffer-gcal — turns a Buffer publishing schedule into a subscribable
 * iCalendar feed.
 *
 * Route groups:
 *   /                  connect a Buffer API key (also signs in)
 *   /calendars/*        create and manage feeds
 *   /feed/:token.ics    the public feed calendar clients poll
 */

import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';

import { getCalendarByToken } from './db.js';
import { respondWithFeed } from './feed.js';
import { authRoutes } from './routes/auth.jsx';
import { calendarRoutes } from './routes/calendars.jsx';
import { withUser, type AppBindings } from './session.js';
import { Layout, Notice } from './ui/layout.jsx';

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
 * Rejects cross-origin form posts. Calendar feeds are read-only GETs, so this
 * applies only to the authenticated management UI.
 */
app.use('*', csrf());
app.use('*', withUser);

app.route('/', authRoutes);
app.route('/', calendarRoutes);

app.notFound((c) =>
  c.html(
    <Layout title="Not found — Buffer → Calendar" user={c.get('user')}>
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
      <Layout title="Request blocked — Buffer → Calendar" user={c.get('user')}>
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
    <Layout title="Something went wrong — Buffer → Calendar" user={c.get('user')}>
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

export default app;

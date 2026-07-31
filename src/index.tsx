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
import { secureHeaders } from 'hono/secure-headers';

import { fetchAvatar, verifiedAvatarTarget } from './avatar.js';
import { getOutputByToken, outputsDueForPush } from './db.js';
import { appOrigin, type Env } from './env.js';
import { respondWithFeed } from './feed.js';
import { authRoutes } from './routes/auth.jsx';
import { outputRoutes } from './routes/outputs.jsx';
import { faqRoutes } from './routes/faq.jsx';
import { googleRoutes } from './routes/google.jsx';
import { privacyRoutes } from './routes/privacy.jsx';
import { tosRoutes } from './routes/tos.jsx';
import { withUser, type AppBindings } from './session.js';
import { pushOutput } from './sync/push.js';
import { Layout, Notice } from './ui/layout.jsx';
import { MARK_SVG } from './ui/mark.jsx';

const app = new Hono<AppBindings>();

/**
 * Canonical host. Two legacy `bgreen.lol` hostnames still resolve so existing
 * ICS/Atom subscribers aren't broken, but every HTML surface should consolidate
 * onto this one — three hosts serving identical marketing pages is duplicate
 * content, and only this host is what canonical tags and the sitemap name.
 */
const CANONICAL_HOST = 'socialsindy.com';
const LEGACY_HOSTS = new Set(['social-sindy.bgreen.lol', 'social-cally.bgreen.lol']);

/**
 * Baseline response hardening, applied ahead of every route including the
 * feed — those responses sit behind an unguessable token but are still worth
 * protecting from framing and MIME-sniffing. CSP is scoped to the app's only
 * real dependencies: Google Fonts (styles/fonts), GoatCounter (pageview
 * script + its own endpoint), and Cloudflare's own auto-injected RUM beacon.
 *
 * `'unsafe-inline'` on script-src and style-src is a real, known trade-off,
 * not an oversight: the layout has a small inline bootstrap script (clipboard
 * copy + the async font-loader below) and one inline `<style>` block, and
 * neither is worth a per-request nonce-threading refactor across every route
 * that renders `<Layout>` for what this app actually needs to defend against.
 *
 * Registered before the redirect middleware below, not after: Hono composes
 * `app.use` in registration order, and a middleware that returns a response
 * without calling `next()` — which the redirect below does for every request
 * it redirects — skips everything registered later. Headers, including HSTS
 * on the very response that's upgrading a visitor to HTTPS, must not depend
 * on whether that particular request happened to redirect.
 */
app.use(
  '*',
  secureHeaders({
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    xFrameOptions: 'DENY',
    referrerPolicy: 'strict-origin-when-cross-origin',
    // Empty arrays, not `false`: hono renders `false` as the legacy
    // Feature-Policy token `none`, but the Permissions-Policy spec's
    // structured-header syntax for "deny to everyone" is an empty list, `()`.
    permissionsPolicy: { geolocation: [], camera: [], microphone: [] },
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://gc.zgo.at', 'https://static.cloudflareinsights.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: [
        "'self'",
        'https://social-sindy.goatcounter.com',
        'https://static.cloudflareinsights.com',
      ],
    },
  }),
);

/**
 * Upgrades plain HTTP to HTTPS everywhere, and consolidates the legacy hosts
 * onto the canonical one — except for feed paths and the health check.
 *
 * Feed URLs are excluded from the host redirect on purpose: they contain a
 * long-lived, unguessable token that existing calendar/RSS subscribers on the
 * legacy hosts already have saved, and a subscriber's client software may not
 * re-save a redirected URL. The HTTPS upgrade still applies to feed requests,
 * though — a feed token is exactly the kind of thing that must never cross the
 * wire in cleartext, so that half of this redirect is not optional for them.
 *
 * `/healthz` is excluded from the host redirect too, since an uptime monitor
 * pinging a specific hostname wants a 200 from that host, not a redirect.
 *
 * 308, not 301: a permanent redirect that Google treats identically to 301 for
 * indexing purposes, but that also preserves the request method — a stray POST
 * arriving over plain HTTP should not be silently downgraded to a GET.
 *
 * The HTTPS check reads Cloudflare's `cf-visitor` header rather than
 * `new URL(c.req.url).protocol`: `wrangler dev` rewrites the request URL's
 * host to match this Worker's configured custom-domain route for realistic
 * local testing, but always serves plain HTTP locally (no local TLS listener)
 * — so the raw protocol can't tell "real plain-HTTP visitor" apart from
 * "ordinary local dev request" and would redirect-loop `pnpm dev` forever.
 * `cf-visitor` only exists behind Cloudflare's actual edge, so its absence
 * safely means "not production" and this step is skipped, exactly as it is
 * today with no redirect middleware at all.
 */
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const isLegacyHost =
    LEGACY_HOSTS.has(url.hostname) && !url.pathname.startsWith('/feed/') && url.pathname !== '/healthz';

  let needsHttps = false;
  const cfVisitor = c.req.header('cf-visitor');
  if (cfVisitor) {
    try {
      needsHttps = JSON.parse(cfVisitor).scheme === 'http';
    } catch {
      // Malformed header from an untrusted-in-shape source — ignore rather
      // than let a parse failure misfire a redirect.
    }
  }

  if (isLegacyHost || needsHttps) {
    url.protocol = 'https:';
    if (isLegacyHost) url.hostname = CANONICAL_HOST;
    return c.redirect(url.toString(), 308);
  }

  return next();
});

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
 * Channel avatars, proxied so they can be served from this origin under the
 * app's `img-src 'self'` policy. See `src/avatar.ts` for why that indirection
 * is needed at all.
 *
 * Above the session and CSRF middleware for the same reason as the favicon:
 * these are images a browser fetches as page subresources. The HMAC in the
 * query string is what authorizes the fetch, not a cookie — nothing here is
 * user-specific, and an avatar is a public image on a public CDN either way.
 *
 * Responses are held in Cloudflare's own cache keyed on the signed URL, so a
 * user reloading the picker with a dozen channels does not re-fetch a dozen
 * third-party CDNs on every render.
 */
app.get('/avatar', async (c) => {
  const url = new URL(c.req.url);
  const upstream = await verifiedAvatarTarget(c.env, url.searchParams);
  if (!upstream) return c.notFound();

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const response = await fetchAvatar(upstream);
  if (response.status === 200) {
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
});

/**
 * The public marketing pages, and the only ones that belong in a sitemap. Every
 * other surface is either behind a session or a machine endpoint, and each of
 * these opts into indexing explicitly at its own `<Layout>`.
 */
const INDEXABLE_PATHS = ['/', '/faq', '/privacy', '/terms'];

/**
 * Paths no crawler should spend budget on.
 *
 * `/feed` is deliberately absent. Some feed aggregators check robots.txt before
 * fetching, so disallowing it risks breaking real Atom subscribers — and it
 * would buy nothing, because feed tokens are unguessable and never linked, so a
 * crawler has no way to reach one in the first place.
 */
const CRAWLER_DISALLOW = ['/sindies', '/auth', '/google', '/healthz'];

/**
 * robots.txt and the sitemap, above the session and CSRF middleware for the same
 * reason as the favicon: public, cacheable, and not worth a cookie lookup.
 *
 * NOTE: Cloudflare also serves a managed robots.txt on this zone, which is what
 * responded before this route existed. Verify after deploy that this one wins;
 * if it does not, turn the managed robots.txt off in the dashboard.
 */
app.get('/robots.txt', (c) => {
  const lines = [
    'User-agent: *',
    ...CRAWLER_DISALLOW.map((path) => `Disallow: ${path}`),
    'Allow: /',
    '',
    `Sitemap: ${appOrigin(c.env)}/sitemap.xml`,
    '',
  ];

  return c.body(lines.join('\n'), 200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'public, max-age=86400',
  });
});

app.get('/sitemap.xml', (c) => {
  const origin = appOrigin(c.env);
  const urls = INDEXABLE_PATHS.map((path) => `  <url><loc>${origin}${path}</loc></url>`);

  // No <lastmod>. These pages change when the code does, and a value invented at
  // request time would be a lie a crawler learns to distrust.
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');

  return c.body(xml, 200, {
    'content-type': 'application/xml; charset=utf-8',
    'cache-control': 'public, max-age=86400',
  });
});

/**
 * Rejects cross-origin form posts. Feeds are read-only GETs, so this
 * applies only to the authenticated management UI.
 */
app.use('*', csrf());
app.use('*', withUser);

app.route('/', privacyRoutes);
app.route('/', tosRoutes);
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
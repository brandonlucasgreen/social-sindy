/**
 * Connecting a Buffer account, which is also how a user signs in.
 *
 * Two ways in, and which appear depends on this deployment's configuration.
 *
 * "Sign in with Buffer" (OAuth, authorization code + PKCE) is preferred and
 * shown first wherever a client is registered, because it can ask for
 * read-only scopes. It needs a public HTTPS redirect URI, so it cannot be
 * exercised from plain localhost.
 *
 * Pasting a personal API key remains as the fallback, and stays supported
 * indefinitely for the accounts that already use one. A key grants full account
 * access including publishing, which the page says plainly.
 *
 * Either way the result is identical downstream: a user row plus a credential.
 */

import { Hono } from 'hono';

import { BufferAuthError, BufferClient, BufferRateLimitError } from '../buffer/client.js';
import { bufferOAuthConfig } from '../buffer/config.js';
import {
  authorizationUrl,
  createPkcePair,
  exchangeCode,
  hasRequiredScopes,
  BufferOAuthError,
} from '../buffer/oauth.js';
import { invalidateAccessToken } from '../buffer/token.js';
import { fingerprintSecret, randomToken, sealSecret } from '../crypto.js';
import {
  deleteCredential,
  deleteSession,
  deleteUser,
  saveBufferOAuthCredential,
  saveCredential,
  upsertUser,
} from '../db.js';
import { serviceColor, serviceLabel } from '../present.js';
import { Layout, Notice } from '../ui/layout.jsx';
import {
  clearSessionCookie,
  invalidateLookups,
  startSession,
  type AppBindings,
  type AppContext,
} from '../session.js';
import { getCookie } from 'hono/cookie';
import { SESSION_COOKIE } from '../session.js';

export const authRoutes = new Hono<AppBindings>();

const KEY_SETTINGS_URL = 'https://publish.buffer.com/settings/api';

/** The OAuth round trip holds its PKCE verifier server-side, never in a cookie. */
const STATE_TTL_SECONDS = 600;

/**
 * Illustrative sample content for the hero, not real account data. It exists to
 * show the actual output — network-coloured post chips laid across a week —
 * rather than describe it in prose.
 */
const SAMPLE_WEEK: { day: string; today?: boolean; posts: { service: string; text: string }[] }[] = [
  { day: 'Mon', posts: [{ service: 'linkedin', text: 'Closing the laptop' }] },
  { day: 'Tue', posts: [{ service: 'threads', text: 'Booze cruise idea' }, { service: 'bluesky', text: 'What are you…' }] },
  { day: 'Wed', today: true, posts: [{ service: 'instagram', text: '$0.003 a stream' }] },
  { day: 'Thu', posts: [{ service: 'mastodon', text: 'Buy direct' }] },
  { day: 'Fri', posts: [{ service: 'threads', text: 'Friday links' }, { service: 'youtube', text: 'New demo' }] },
  { day: 'Sat', posts: [] },
  { day: 'Sun', posts: [{ service: 'pinterest', text: 'Sleeve art' }] },
];

const HeroDemo = () => (
  <figure class="demo">
    <div class="demo-head">
      <b>Buffer — Cult of Lightbulbs</b>
      <span>This week</span>
    </div>
    <div class="week">
      {SAMPLE_WEEK.map((day) => (
        <div class={day.today ? 'day today' : 'day'}>
          <b>{day.day}</b>
          {day.posts.map((post) => (
            <div class="chip" style={`--net:${serviceColor(post.service)}`}>
              <span title={`${serviceLabel(post.service)} — ${post.text}`}>{post.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
    <figcaption class="small" style="margin-top:0.75rem">
      Example of the result. Each scheduled post becomes an event, coloured by network.
    </figcaption>
  </figure>
);

/** The pasted-key path. Primary when no OAuth client is registered, tucked
 *  behind a disclosure when there is one. */
const ApiKeyForm = ({ labelled }: { labelled?: boolean }) => (
  <form method="post" action="/connect">
    {labelled ? <label for="apiKey">Buffer API key</label> : null}
    <div class="inline-form">
      <input
        type="password"
        id="apiKey"
        name="apiKey"
        required
        autocomplete="off"
        spellcheck={false}
        placeholder="Paste your Buffer API key"
      />
      <button type="submit">Connect Buffer</button>
    </div>
    <small style="display:block;margin-top:0.625rem">
      Create a key under{' '}
      <a href={KEY_SETTINGS_URL} target="_blank" rel="noreferrer noopener">
        Buffer → Settings → API
      </a>
      . Connecting it also signs you in — there is no separate account.
    </small>
  </form>
);

function ConnectPage({ error, oauth }: { error?: string; oauth: boolean }) {
  return (
    <Layout title="social-cally — your Buffer queue in your calendar">
      <h1>Your content schedule, in the calendar you actually check.</h1>
      <p class="lede">
        Connect Buffer, choose your channels, and get a calendar you can subscribe to in Google
        Calendar, Apple Calendar, or Outlook.
      </p>

      <HeroDemo />

      {error ? <Notice kind="error">{error}</Notice> : null}

      {oauth ? (
        <>
          <div class="btn-row">
            <a class="btn" href="/auth/buffer">
              Sign in with Buffer
            </a>
          </div>
          <small style="display:block;margin-top:0.625rem">
            Buffer will ask you to approve <strong>read-only</strong> access to your account and
            posts. Signing in also creates your account here — there is nothing separate to set up.
          </small>

          <details style="margin-top:1.5rem">
            <summary>Use an API key instead</summary>
            <p class="small" style="margin-top:0.75rem">
              Only needed if signing in does not work for you. A key grants full account access,
              including publishing, so signing in above is the safer route.
            </p>
            <ApiKeyForm />
          </details>
        </>
      ) : (
        <ApiKeyForm labelled />
      )}

      <h2>What it can and cannot do</h2>
      <div class="trust">
        <div>
          <h3>
            <span class="tick" aria-hidden="true">
              ✓
            </span>
            Reads your schedule
          </h3>
          <p>Your account, channel list, and scheduled posts. Nothing else.</p>
        </div>
        <div>
          <h3>
            <span class="tick" aria-hidden="true">
              ✓
            </span>
            Encrypted at rest
          </h3>
          <p>Your Buffer credential is sealed with AES-256-GCM and never written to a log.</p>
        </div>
        <div>
          <h3>
            <span class="tick" aria-hidden="true">
              ✓
            </span>
            Revocable anytime
          </h3>
          <p>Revoke access in Buffer, or delete your account here, and access ends.</p>
        </div>
        <div>
          <h3>Never publishes</h3>
          <p>No post is created, edited, or deleted in your Buffer account.</p>
        </div>
      </div>

      {oauth ? null : (
        <Notice>
          <p>
            <strong>Worth knowing before you paste it.</strong> A Buffer API key grants full access
            to your Buffer account, including publishing. This tool only ever reads — but a key is a
            broad credential, so handing one over is a real decision. This deployment has no Buffer
            sign-in configured, which would let it ask for read-only access instead; until it does,
            a key is the way in.
          </p>
        </Notice>
      )}
    </Layout>
  );
}

authRoutes.get('/', (c) => {
  if (c.get('user')) return c.redirect('/calendars', 302);
  return c.html(<ConnectPage oauth={bufferOAuthConfig(c.env) !== null} />);
});

// -- sign in with buffer (oauth) ---------------------------------------------

/**
 * Re-renders the connect page with an error. Shared by both paths so a failure
 * always comes back with the same options the user started with.
 */
function connectFailed(
  c: AppContext,
  message: string,
  status: 400 | 429 | 501 | 502 = 400,
) {
  return c.html(<ConnectPage error={message} oauth={bufferOAuthConfig(c.env) !== null} />, status);
}

authRoutes.get('/auth/buffer', async (c) => {
  const config = bufferOAuthConfig(c.env);
  if (!config) {
    return connectFailed(c, 'This deployment has no Buffer sign-in configured. Use an API key.', 501);
  }

  const { verifier, challenge } = await createPkcePair();
  const state = randomToken(24);

  // The verifier stays server-side for the round trip. Putting it in a cookie
  // would hand the PKCE secret to the very browser PKCE exists to distrust.
  await c.env.FEED_CACHE.put(`bstate:${state}`, JSON.stringify({ verifier }), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  return c.redirect(authorizationUrl(config, state, challenge), 302);
});

authRoutes.get('/auth/callback', async (c) => {
  const config = bufferOAuthConfig(c.env);
  if (!config) {
    return connectFailed(c, 'This deployment has no Buffer sign-in configured. Use an API key.', 501);
  }

  const denied = c.req.query('error');
  if (denied) {
    return connectFailed(
      c,
      denied === 'access_denied'
        ? 'You declined the Buffer authorization, so nothing was connected.'
        : `Buffer refused the authorization: ${denied}`,
    );
  }

  const state = c.req.query('state');
  const code = c.req.query('code');
  if (!state || !code) return connectFailed(c, 'That sign-in link was incomplete. Try again.');

  // Consuming the state before use makes it single-shot, which is what stops a
  // replayed callback from re-running the exchange.
  const stored = await c.env.FEED_CACHE.get(`bstate:${state}`, 'json');
  await c.env.FEED_CACHE.delete(`bstate:${state}`);
  if (!stored) {
    return connectFailed(c, 'That sign-in attempt expired or was already used. Try again.');
  }

  let tokens;
  try {
    tokens = await exchangeCode(config, code, (stored as { verifier: string }).verifier);
  } catch (error) {
    const message =
      error instanceof BufferOAuthError ? error.message : `Could not reach Buffer: ${String(error)}`;
    return connectFailed(c, message, 502);
  }

  if (!hasRequiredScopes(tokens.scope)) {
    return connectFailed(
      c,
      'That authorization did not include permission to read your account and posts, which this tool needs to build a calendar.',
    );
  }

  // Without a refresh token the calendar would stop updating within the hour,
  // which is worse than refusing to connect.
  if (!tokens.refreshToken) {
    return connectFailed(
      c,
      'Buffer did not return a durable authorization, so the calendar could not be kept up to date. Try again, or use an API key.',
    );
  }

  let account;
  try {
    account = (await new BufferClient(tokens.accessToken).getAccount()).data;
  } catch (error) {
    if (error instanceof BufferRateLimitError) {
      return connectFailed(c, "Buffer's rate limit is exhausted for this account. Try again shortly.", 502);
    }
    return connectFailed(c, `Buffer signed you in but the account could not be read: ${(error as Error).message}`, 502);
  }

  const user = await upsertUser(c.env.DB, {
    bufferAccountId: account.id,
    email: account.email,
    name: account.name,
    timezone: account.timezone ?? 'UTC',
  });

  await saveBufferOAuthCredential(
    c.env.DB,
    user.id,
    await sealSecret(tokens.refreshToken, c.env.ENCRYPTION_KEY),
    { scope: tokens.scope },
  );

  // Upgrading from a pasted key: drop it rather than leaving a full-access
  // credential at rest for an account that now has a read-only one.
  await deleteCredential(c.env.DB, user.id);

  await invalidateAccessToken(c.env, user.id);
  await invalidateLookups(
    c.env,
    user.id,
    account.organizations.map((org) => org.id),
  );

  await startSession(c, user.id);
  return c.redirect('/calendars', 302);
});

authRoutes.post('/connect', async (c) => {
  const body = await c.req.parseBody();
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

  if (!apiKey) {
    return connectFailed(c, 'Please paste your Buffer API key.', 400);
  }

  // Validate the key by using it, so a bad key is rejected before we store it.
  let account;
  try {
    account = (await new BufferClient(apiKey).getAccount()).data;
  } catch (error) {
    if (error instanceof BufferAuthError) {
      return connectFailed(
        c,
        'Buffer rejected that key. Check that you copied all of it, and that it has not been revoked.',
        400,
      );
    }
    if (error instanceof BufferRateLimitError) {
      return connectFailed(
        c,
        "Buffer's API rate limit is currently exhausted for this key. Try again in a few minutes.",
        429,
      );
    }
    return connectFailed(c, `Could not reach Buffer: ${(error as Error).message}`, 502);
  }

  const user = await upsertUser(c.env.DB, {
    bufferAccountId: account.id,
    email: account.email,
    name: account.name,
    timezone: account.timezone ?? 'UTC',
  });

  const sealed = await sealSecret(apiKey, c.env.ENCRYPTION_KEY);
  await saveCredential(c.env.DB, user.id, sealed, await fingerprintSecret(apiKey));

  // A replaced key may see different organizations; drop anything cached.
  await invalidateLookups(
    c.env,
    user.id,
    account.organizations.map((org) => org.id),
  );

  await startSession(c, user.id);
  return c.redirect('/calendars', 302);
});

authRoutes.post('/signout', async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await deleteSession(c.env.DB, sessionId);
  clearSessionCookie(c);
  return c.redirect('/', 302);
});

/** Removes the account, its stored key, and every calendar it created. */
authRoutes.post('/account/delete', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect('/', 302);

  await deleteUser(c.env.DB, user.id);
  await invalidateLookups(c.env, user.id, []);
  clearSessionCookie(c);
  return c.redirect('/', 302);
});

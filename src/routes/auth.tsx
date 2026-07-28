/**
 * Connecting a Buffer account, which is also how a user signs in.
 *
 * Sign in with Buffer (OAuth, authorization code + PKCE) is the only public
 * auth path. It asks for read-only scopes, so the tool can never publish.
 *
 * The pasted-key path is removed from the UI but the route remains for any
 * accounts that already use one. A key grants full account access including
 * publishing.
 */

import { Hono } from 'hono';

import { BufferAuthError, BufferClient, BufferRateLimitError } from '../buffer/client.js';
import { bufferOAuthConfig } from '../buffer/config.js';
import {
  authorizationUrl,
  BUFFER_SCOPES,
  createPkcePair,
  describeAuthorizationError,
  exchangeCode,
  hasRequiredScopes,
  promptRejected,
  BufferOAuthError,
  type BufferOAuthConfig,
} from '../buffer/oauth.js';
import { invalidateAccessToken } from '../buffer/token.js';
import { fingerprintSecret, randomToken, sealSecret } from '../crypto.js';
import { appOrigin } from '../env.js';
import {
  deleteCredential,
  deleteSession,
  deleteUser,
  getBufferOAuthCredential,
  getUserByBufferAccountId,
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

/** The OAuth round trip holds its PKCE verifier server-side, never in a cookie. */
const STATE_TTL_SECONDS = 600;

/**
 * Illustrative sample content for the hero, not real account data. It exists to
 * show the actual output - network-coloured post chips laid across a week -
 * rather than describe it in prose.
 */
const SAMPLE_WEEK: { day: string; today?: boolean; posts: { service: string; text: string }[] }[] = [
  { day: 'Mon', posts: [{ service: 'linkedin', text: 'Closing the laptop' }] },
  { day: 'Tue', posts: [{ service: 'threads', text: 'Booze cruise idea' }, { service: 'bluesky', text: 'What are you...' }] },
  { day: 'Wed', today: true, posts: [{ service: 'instagram', text: '$0.003 a stream' }] },
  { day: 'Thu', posts: [{ service: 'mastodon', text: 'Buy direct' }] },
  { day: 'Fri', posts: [{ service: 'threads', text: 'Friday links' }, { service: 'youtube', text: 'New demo' }] },
  { day: 'Sat', posts: [] },
  { day: 'Sun', posts: [{ service: 'pinterest', text: 'Sleeve art' }] },
];

const HeroDemo = () => (
  <figure class="demo">
    <div class="demo-head">
      <b>Buffer - Cult of Lightbulbs</b>
      <span>This week</span>
    </div>
    <div class="week">
      {SAMPLE_WEEK.map((day) => (
        <div class={day.today ? 'day today' : 'day'}>
          <b>{day.day}</b>
          {day.posts.map((post) => (
            <div class="chip" style={`--net:${serviceColor(post.service)}`}>
              <span title={`${serviceLabel(post.service)} - ${post.text}`}>{post.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
    <figcaption class="small" style="margin-top:0.75rem">
      Example of the result. Each scheduled post becomes an event, colored by network.
    </figcaption>
  </figure>
);

/**
 * The homepage doubles as the connect page, so it is both the marketing surface
 * and the start of the OAuth flow. It is public and indexable; every other page
 * this file renders is not.
 */
const HOME_DESCRIPTION =
  'Turn your Buffer publishing schedule into feeds you can subscribe to: a calendar feed (ICS) for Google Calendar, Apple Calendar, or Outlook, and a content feed (Atom/RSS) for your blog or reader. One read-only connection, both formats.';

function ConnectPage({ error, origin }: { error?: string; origin: string }) {
  return (
    <Layout
      title="social sindy - your Buffer queue as feeds"
      description={HOME_DESCRIPTION}
      canonical={`${origin}/`}
      indexable
    >
      <h1>Your content schedule, as feeds you actually subscribe to.</h1>
      <p class="lede">
        Connect Buffer, choose your channels, and get a calendar feed (ICS) for Google Calendar,
        Apple Calendar, or Outlook - plus a content feed (Atom/RSS) for your blog or RSS reader.
        One connection, both formats.
      </p>

      <HeroDemo />

      {error ? <Notice kind="error">{error}</Notice> : null}

      <div class="btn-row">
        <a class="btn" href="/auth/buffer">
          Sign in with Buffer
        </a>
      </div>
      <small style="display:block;margin-top:0.625rem">
        Buffer will ask you to approve <strong>read-only</strong> access to your account and
        posts. Signing in also creates your account here - there is nothing separate to set up.
      </small>

      <h2>What can you use it for?</h2>
      <div class="use-cases">
        <div class="use-case">
          <div class="use-case-icon">📅</div>
          <h3>Team calendar</h3>
          <p>Add your content schedule to a shared Google Calendar or Outlook so the whole team can see what's coming up - without logging into Buffer.</p>
        </div>
        <div class="use-case">
          <div class="use-case-icon">✉️</div>
          <h3>RSS to email</h3>
          <p>Pipe the feed into Buttondown, Mailchimp, or FeedMail and every post becomes an email send. No manual work.</p>
        </div>
        <div class="use-case">
          <div class="use-case-icon">📖</div>
          <h3>Personal journal</h3>
          <p>Subscribe in Reeder, NetNewsWire, or your favorite RSS app and revisit your posts in a clean, reader-like view.</p>
        </div>
        <div class="use-case">
          <div class="use-case-icon">🌐</div>
          <h3>Website widget</h3>
          <p>Embed a cross-network feed on your site - every channel in one place, not separate widgets for each social network.</p>
        </div>
        <div class="use-case">
          <div class="use-case-icon">🗂️</div>
          <h3>Content archive</h3>
          <p>A searchable record of everything you've posted, always available even if a platform changes or disappears.</p>
        </div>
        <div class="use-case">
          <div class="use-case-icon">🔗</div>
          <h3>Anything that reads a feed</h3>
          <p>ICS and Atom are open standards - any tool that accepts a calendar URL or RSS URL just works. The possibilities are wide open.</p>
        </div>
      </div>

      <h2>How it works</h2>
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
    </Layout>
  );
}

authRoutes.get('/', (c) => {
  if (c.get('user')) return c.redirect('/sindies', 302);
  return c.html(<ConnectPage origin={appOrigin(c.env)} />);
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
  return c.html(<ConnectPage error={message} origin={appOrigin(c.env)} />, status);
}

/** What the round trip parks in KV, keyed by the `state` it hands the browser. */
interface AuthState {
  verifier: string;
  /** Whether this attempt asked for `prompt=consent`, so a rejection is legible. */
  forceConsent?: boolean;
}

/**
 * Starts a round trip: PKCE pair, single-use state, consent URL.
 *
 * The verifier stays server-side. Putting it in a cookie would hand the PKCE
 * secret to the very browser PKCE exists to distrust.
 */
async function beginAuthorization(
  c: AppContext,
  config: BufferOAuthConfig,
  forceConsent: boolean,
): Promise<string> {
  const { verifier, challenge } = await createPkcePair();
  const state = randomToken(24);

  const record: AuthState = { verifier, forceConsent };
  await c.env.FEED_CACHE.put(`bstate:${state}`, JSON.stringify(record), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  return authorizationUrl(config, state, challenge, { forceConsent });
}

/**
 * Reads and destroys a state record.
 *
 * Consuming before use is what makes it single-shot, and single-shot is what
 * stops a replayed callback from re-running the exchange.
 */
async function consumeState(c: AppContext, state: string | undefined): Promise<AuthState | null> {
  if (!state) return null;
  const stored = await c.env.FEED_CACHE.get(`bstate:${state}`, 'json');
  await c.env.FEED_CACHE.delete(`bstate:${state}`);
  return (stored as AuthState | null) ?? null;
}

authRoutes.get('/auth/buffer', async (c) => {
  const config = bufferOAuthConfig(c.env);
  if (!config) {
    return connectFailed(c, 'This deployment has no Buffer sign-in configured.', 501);
  }

  return c.redirect(await beginAuthorization(c, config, true), 302);
});

authRoutes.get('/auth/callback', async (c) => {
  const config = bufferOAuthConfig(c.env);
  if (!config) {
    return connectFailed(c, 'This deployment has no Buffer sign-in configured.', 501);
  }

  const denied = c.req.query('error');
  if (denied) {
    const description = c.req.query('error_description');

    // A server that will not take `prompt=consent` reports a malformed request,
    // not a refusal - blaming the user for a parameter they never saw would be
    // both wrong and unactionable. Retry once without it. The retry records
    // `forceConsent: false`, so this cannot loop.
    const attempt = await consumeState(c, c.req.query('state'));
    if (attempt?.forceConsent && promptRejected(denied, description)) {
      return c.redirect(await beginAuthorization(c, config, false), 302);
    }

    return connectFailed(c, describeAuthorizationError(denied, description));
  }

  const state = c.req.query('state');
  const code = c.req.query('code');
  if (!state || !code) return connectFailed(c, 'That sign-in link was incomplete. Try again.');

  const stored = await consumeState(c, state);
  if (!stored) {
    return connectFailed(c, 'That sign-in attempt expired or was already used. Try again.');
  }

  let tokens;
  try {
    tokens = await exchangeCode(config, code, stored.verifier);
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

  // Read the account before judging the grant. Whether this authorization is
  // durable enough to sign in on depends on what is already stored for whoever
  // just signed in, and until the account is known, that cannot be asked.
  let account;
  try {
    account = (await new BufferClient(tokens.accessToken).getAccount()).data;
  } catch (error) {
    if (error instanceof BufferRateLimitError) {
      return connectFailed(c, "Buffer's rate limit is exhausted for this account. Try again shortly.", 502);
    }
    return connectFailed(c, `Buffer signed you in but the account could not be read: ${(error as Error).message}`, 502);
  }

  // Buffer omits the refresh token when it skips an approval screen the user
  // has already given - which is exactly what signing in on a second device
  // looks like. The grant already on file is untouched by that and still keeps
  // the calendar fresh, so this is an ordinary sign-in, not a failure. Only
  // when there is nothing to fall back on is the authorization really unusable.
  const existing = await getUserByBufferAccountId(c.env.DB, account.id);
  const onFile = existing ? await getBufferOAuthCredential(c.env.DB, existing.id) : null;

  if (!tokens.refreshToken && !onFile) {
    return connectFailed(
      c,
      'Buffer signed you in but did not return a durable authorization, so the calendar could not be kept up to date. Revoke this app under your Buffer account settings and sign in again.',
    );
  }

  const user = await upsertUser(c.env.DB, {
    bufferAccountId: account.id,
    email: account.email,
    name: account.name,
    timezone: account.timezone ?? 'UTC',
  });

  // Only a token actually issued gets stored. Overwriting a live grant with
  // nothing is how a working account becomes a locked-out one.
  if (tokens.refreshToken) {
    await saveBufferOAuthCredential(
      c.env.DB,
      user.id,
      await sealSecret(tokens.refreshToken, c.env.ENCRYPTION_KEY),
      // Record what we asked for when Buffer declines to say, so the stored row
      // always describes the grant rather than holding an empty string.
      { scope: tokens.scope ?? BUFFER_SCOPES.join(' ') },
    );

    // Upgrading from a pasted key: drop it rather than leaving a full-access
    // credential at rest for an account that now has a read-only one.
    await deleteCredential(c.env.DB, user.id);

    await invalidateAccessToken(c.env, user.id);
  }

  await invalidateLookups(
    c.env,
    user.id,
    account.organizations.map((org) => org.id),
  );

  await startSession(c, user.id);
  return c.redirect('/sindies', 302);
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
  return c.redirect('/sindies', 302);
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

/**
 * Connecting a Buffer account, which is also how a user signs in.
 *
 * Buffer has not enabled third-party OAuth on its GraphQL API, so users paste a
 * personal API key from publish.buffer.com/settings/api. The key is validated
 * against the API, then sealed with AES-256-GCM before it touches the database.
 * When OAuth does become available, it replaces this handler without changing
 * the rest of the app: everything downstream only needs a user and a credential.
 */

import { Hono } from 'hono';

import { BufferAuthError, BufferClient, BufferRateLimitError } from '../buffer/client.js';
import { fingerprintSecret, sealSecret } from '../crypto.js';
import { deleteSession, deleteUser, saveCredential, upsertUser } from '../db.js';
import { serviceColor, serviceLabel } from '../present.js';
import { Layout, Notice } from '../ui/layout.jsx';
import {
  clearSessionCookie,
  invalidateLookups,
  startSession,
  type AppBindings,
} from '../session.js';
import { getCookie } from 'hono/cookie';
import { SESSION_COOKIE } from '../session.js';

export const authRoutes = new Hono<AppBindings>();

const KEY_SETTINGS_URL = 'https://publish.buffer.com/settings/api';

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

function ConnectPage({ error }: { error?: string }) {
  return (
    <Layout title="buffer-cal — your Buffer queue in your calendar">
      <h1>Your posting queue, in the calendar you actually check.</h1>
      <p class="lede">
        Connect Buffer, choose your channels, and get a calendar you can subscribe to in Google
        Calendar, Apple Calendar, or Outlook.
      </p>

      <HeroDemo />

      {error ? <Notice kind="error">{error}</Notice> : null}

      <form method="post" action="/connect">
        <label for="apiKey">Buffer API key</label>
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
          <p>Your key is sealed with AES-256-GCM and never written to a log.</p>
        </div>
        <div>
          <h3>
            <span class="tick" aria-hidden="true">
              ✓
            </span>
            Revocable anytime
          </h3>
          <p>Delete the key in Buffer, or delete your account here, and access ends.</p>
        </div>
        <div>
          <h3>Never publishes</h3>
          <p>No post is created, edited, or deleted in your Buffer account.</p>
        </div>
      </div>

      <Notice>
        <p>
          <strong>Worth knowing before you paste it.</strong> A Buffer API key grants full access to
          your Buffer account, including publishing — Buffer does not yet offer scoped third-party
          OAuth, so a key is currently the only way in. This tool only ever reads, but you are
          trusting it with a broad credential, so treat that as a real decision.
        </p>
      </Notice>
    </Layout>
  );
}

authRoutes.get('/', (c) => {
  if (c.get('user')) return c.redirect('/calendars', 302);
  return c.html(<ConnectPage />);
});

authRoutes.post('/connect', async (c) => {
  const body = await c.req.parseBody();
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

  if (!apiKey) {
    return c.html(<ConnectPage error="Please paste your Buffer API key." />, 400);
  }

  // Validate the key by using it, so a bad key is rejected before we store it.
  let account;
  try {
    account = (await new BufferClient(apiKey).getAccount()).data;
  } catch (error) {
    if (error instanceof BufferAuthError) {
      return c.html(
        <ConnectPage error="Buffer rejected that key. Check that you copied all of it, and that it has not been revoked." />,
        400,
      );
    }
    if (error instanceof BufferRateLimitError) {
      return c.html(
        <ConnectPage error="Buffer's API rate limit is currently exhausted for this key. Try again in a few minutes." />,
        429,
      );
    }
    return c.html(
      <ConnectPage error={`Could not reach Buffer: ${(error as Error).message}`} />,
      502,
    );
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

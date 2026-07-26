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

function ConnectPage({ error }: { error?: string }) {
  return (
    <Layout title="Connect Buffer — Buffer → Calendar">
      <h1>See your Buffer queue in your calendar</h1>
      <p class="lede">
        Pick the channels you care about and get a calendar feed you can subscribe to in Google
        Calendar, Apple Calendar, or Outlook. Every scheduled post shows up as an event.
      </p>

      {error ? <Notice kind="error">{error}</Notice> : null}

      <div class="card">
        <form method="post" action="/connect">
          <div class="field">
            <label for="apiKey">Buffer API key</label>
            <input
              type="password"
              id="apiKey"
              name="apiKey"
              required
              autocomplete="off"
              spellcheck={false}
              placeholder="Paste your key"
            />
            <small>
              Create one under{' '}
              <a href={KEY_SETTINGS_URL} target="_blank" rel="noreferrer noopener">
                Buffer → Settings → API
              </a>
              . Connecting your key also signs you in.
            </small>
          </div>
          <button type="submit">Connect Buffer</button>
        </form>
      </div>

      <Notice>
        <p>
          <strong>What this key can do.</strong> A Buffer API key grants full access to your Buffer
          account, including publishing. This app only ever reads your account, channels, and
          scheduled posts — but you are trusting it with the key, so it is stored encrypted and you
          can revoke it in Buffer at any time.
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

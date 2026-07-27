/**
 * Connecting Google and driving the Calendar push.
 *
 * The push is optional. When this deployment has no Google OAuth client the
 * routes report that plainly rather than failing obscurely, and the UI omits
 * the controls entirely.
 *
 * Push is ICS-only: it only makes sense for calendar outputs, not Atom feeds.
 */

import { Hono } from 'hono';

import { sealSecret } from '../crypto.js';
import {
  deleteGoogleCredential,
  getOutput,
  getGoogleCredential,
  saveGoogleCredential,
  setPushEnabled,
} from '../db.js';
import { GoogleApiError, GoogleCalendarClient } from '../google/calendar.js';
import {
  authorizationUrl,
  createPkcePair,
  exchangeCode,
  fetchGoogleEmail,
  GoogleAuthError,
  hasCalendarScope,
} from '../google/oauth.js';
import { googleAccessToken, pushOutput } from '../sync/push.js';
import { googleConfig } from '../sync/google-config.js';
import { randomToken } from '../crypto.js';
import { requireUser, type AppBindings, type AppContext } from '../session.js';
import { Layout, Notice } from '../ui/layout.jsx';

export const googleRoutes = new Hono<AppBindings>();

// Scoped rather than '*' — see the note in outputs.tsx. This router serves
// two path families, so both are guarded explicitly.
googleRoutes.use('/google/*', requireUser);
googleRoutes.use('/sindies/:id/push/*', requireUser);

/** OAuth state and PKCE verifier, held server-side for the round trip only. */
const STATE_TTL_SECONDS = 600;

function notConfigured(c: AppContext) {
  return c.html(
    <Layout title="Google push unavailable — social sindy" user={c.get('user')} narrow>
      <h1>Google push is not set up</h1>
      <Notice kind="error">
        This deployment has no Google OAuth client configured, so events cannot be written to Google
        Calendar. The calendar feed still works — subscribe to it instead.
      </Notice>
      <p>
        <a href="/sindies">Back to your sindies</a>
      </p>
    </Layout>,
    501,
  );
}

function pushError(c: AppContext, error: unknown) {
  const reconnect = error instanceof GoogleAuthError && error.needsReconnect;
  const message =
    error instanceof GoogleAuthError || error instanceof GoogleApiError
      ? error.message
      : `Unexpected failure: ${(error as Error).message}`;

  return c.html(
    <Layout title="Google sync failed — social sindy" user={c.get('user')} narrow>
      <h1>That sync did not finish</h1>
      <Notice kind="error">{message}</Notice>
      <div class="btn-row">
        {reconnect ? <a class="btn" href="/google/connect">Reconnect Google</a> : null}
        <a class="btn btn-quiet" href="/sindies">
          Back to your sindies
        </a>
      </div>
    </Layout>,
    502,
  );
}

// -- connect ----------------------------------------------------------------

googleRoutes.get('/google/connect', async (c) => {
  const config = googleConfig(c.env);
  if (!config) return notConfigured(c);

  const user = c.get('user')!;
  const { verifier, challenge } = await createPkcePair();
  const state = randomToken(24);

  await c.env.FEED_CACHE.put(
    `gstate:${state}`,
    JSON.stringify({ userId: user.id, verifier }),
    { expirationTtl: STATE_TTL_SECONDS },
  );

  return c.redirect(authorizationUrl(config, state, challenge), 302);
});

googleRoutes.get('/google/callback', async (c) => {
  const config = googleConfig(c.env);
  if (!config) return notConfigured(c);

  const user = c.get('user')!;
  const state = c.req.query('state');
  const code = c.req.query('code');
  const denied = c.req.query('error');

  if (denied) {
    return c.html(
      <Layout title="Google not connected — social sindy" user={user} narrow>
        <h1>Google was not connected</h1>
        <Notice>You declined the permission request, so nothing changed.</Notice>
        <p>
          <a href="/sindies">Back to your sindies</a>
        </p>
      </Layout>,
    );
  }

  if (!state || !code) return c.redirect('/sindies', 302);

  const stored = (await c.env.FEED_CACHE.get(`gstate:${state}`, 'json')) as
    | { userId: string; verifier: string }
    | null;

  if (!stored || stored.userId !== user.id) {
    return c.html(
      <Layout title="Google not connected — social sindy" user={user} narrow>
        <h1>That sign-in link expired</h1>
        <Notice kind="error">
          The Google sign-in could not be verified. Please start the connection again.
        </Notice>
        <p>
          <a class="btn" href="/google/connect">
            Try again
          </a>
        </p>
      </Layout>,
      400,
    );
  }
  await c.env.FEED_CACHE.delete(`gstate:${state}`);

  try {
    const tokens = await exchangeCode(config, code, stored.verifier);

    if (!tokens.refreshToken) {
      throw new GoogleAuthError(
        'Google did not return a refresh token, which is required to sync in the background. Remove this app from your Google account permissions and connect again.',
      );
    }
    if (!hasCalendarScope(tokens.scope)) {
      throw new GoogleAuthError(
        'The calendar permission was not granted, so events cannot be created.',
      );
    }

    const email = await fetchGoogleEmail(tokens.accessToken);
    const sealed = await sealSecret(tokens.refreshToken, c.env.ENCRYPTION_KEY);
    await saveGoogleCredential(c.env.DB, user.id, sealed, { email, scope: tokens.scope });

    return c.redirect('/sindies?google=connected', 302);
  } catch (error) {
    return pushError(c, error);
  }
});

googleRoutes.post('/google/disconnect', async (c) => {
  const user = c.get('user')!;
  await deleteGoogleCredential(c.env.DB, user.id);
  await c.env.FEED_CACHE.delete(`gtoken:${user.id}`);
  return c.redirect('/sindies', 302);
});

// -- per-output push (ICS only) ---------------------------------------------

googleRoutes.post('/sindies/:id/push/enable', async (c) => {
  const config = googleConfig(c.env);
  if (!config) return notConfigured(c);

  const user = c.get('user')!;
  const output = await getOutput(c.env.DB, c.req.param('id'), user.id);
  if (!output) return c.notFound();

  // Push is ICS-only
  if (output.format !== 'ics') return c.notFound();

  if (!(await getGoogleCredential(c.env.DB, user.id))) {
    return c.redirect('/google/connect', 302);
  }

  await setPushEnabled(c.env.DB, output.id, true);

  // Sync immediately, so enabling it visibly does something rather than waiting
  // for the next scheduled run.
  try {
    const fresh = await getOutput(c.env.DB, output.id, user.id);
    if (fresh) await pushOutput(c.env, fresh);
  } catch (error) {
    return pushError(c, error);
  }

  return c.redirect(`/sindies/${output.id}?push=on`, 302);
});

googleRoutes.post('/sindies/:id/push/disable', async (c) => {
  const user = c.get('user')!;
  const output = await getOutput(c.env.DB, c.req.param('id'), user.id);
  if (!output) return c.notFound();

  await setPushEnabled(c.env.DB, output.id, false);

  return c.redirect(`/sindies/${output.id}?push=off`, 302);
});

googleRoutes.post('/sindies/:id/push/now', async (c) => {
  const config = googleConfig(c.env);
  if (!config) return notConfigured(c);

  const user = c.get('user')!;
  const output = await getOutput(c.env.DB, c.req.param('id'), user.id);
  if (!output) return c.notFound();

  try {
    await pushOutput(c.env, output);
  } catch (error) {
    return pushError(c, error);
  }

  return c.redirect(`/sindies/${output.id}?push=synced`, 302);
});

/** Removes the Google calendar this tool created, on explicit request. */
googleRoutes.post('/sindies/:id/push/remove', async (c) => {
  const config = googleConfig(c.env);
  if (!config) return notConfigured(c);

  const user = c.get('user')!;
  const output = await getOutput(c.env.DB, c.req.param('id'), user.id);
  if (!output) return c.notFound();

  try {
    if (output.google_calendar_id) {
      const accessToken = await googleAccessToken(c.env, user.id, config);
      await new GoogleCalendarClient(accessToken).deleteCalendar(output.google_calendar_id);
    }
    await setPushEnabled(c.env.DB, output.id, false);
    await c.env.DB.prepare('UPDATE outputs SET google_calendar_id = NULL WHERE id = ?')
      .bind(output.id)
      .run();
  } catch (error) {
    return pushError(c, error);
  }

  return c.redirect(`/sindies/${output.id}?push=removed`, 302);
});
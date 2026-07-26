/**
 * Resolves a usable Buffer bearer token for a user, from whichever credential
 * they connected with.
 *
 * Two kinds coexist. A pasted personal API key is already a bearer token and
 * needs nothing. An OAuth grant needs its short-lived access token refreshed,
 * and that refresh is where all the difficulty lives, because Buffer rotates
 * the refresh token on every use.
 *
 * WHY THIS IS NOT JUST "REFRESH AND SAVE": the cron tick and a browser request
 * can refresh the same user at the same moment. Both read refresh token A, both
 * spend it, and whichever lands second gets `invalid_grant` — Buffer has already
 * invalidated A in favour of the winner's B. Naively that logs the user out
 * despite a perfectly good token existing in the database.
 *
 * Two mechanisms, because neither is sufficient alone:
 *
 *  1. A KV lock narrows the window so concurrent refreshes are rare. KV has no
 *     compare-and-set, so this is advisory only and cannot be relied on.
 *  2. On `invalid_grant`, re-read the row from D1 — which IS strongly
 *     consistent, unlike KV — and if another flight has stored a newer token,
 *     retry with it. This is what actually makes the race safe; the lock just
 *     keeps us from hitting it constantly.
 */

import { openSecret, sealSecret } from '../crypto.js';
import {
  getBufferOAuthCredential,
  getCredential,
  saveBufferOAuthCredential,
  type BufferOAuthCredentialRow,
} from '../db.js';
import type { Env } from '../env.js';
import { BufferAuthError } from './client.js';
import { bufferOAuthConfig } from './config.js';
import { BufferOAuthError, refreshAccessToken, type BufferOAuthConfig } from './oauth.js';

/** Access tokens live in KV, never the database — they are short-lived. */
const tokenKey = (userId: string) => `btoken:${userId}`;
const lockKey = (userId: string) => `block:${userId}`;

/** Long enough to cover a token round trip, short enough to self-heal. */
const LOCK_TTL_SECONDS = 60;

/** How long a loser waits for the winner's token before refreshing anyway. */
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when this user signed in with OAuth rather than pasting a key. */
export async function hasOAuthCredential(env: Env, userId: string): Promise<boolean> {
  return (await getBufferOAuthCredential(env.DB, userId)) !== null;
}

async function decryptRefreshToken(env: Env, row: BufferOAuthCredentialRow): Promise<string> {
  return openSecret({ ciphertext: row.ciphertext, iv: row.iv }, env.ENCRYPTION_KEY);
}

/**
 * Refreshes and persists, retrying once against a token another request stored.
 *
 * The retry is conditional on `updated_at` having moved. If it has not, nobody
 * else rotated anything and the grant is genuinely dead, so reconnecting is the
 * only cure and saying so beats retrying forever.
 */
async function refreshAndStore(
  env: Env,
  userId: string,
  config: BufferOAuthConfig,
  row: BufferOAuthCredentialRow,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const attempt = async (current: BufferOAuthCredentialRow) => {
    const tokens = await refreshAccessToken(config, await decryptRefreshToken(env, current));

    // Buffer should always return a replacement. If it ever does not, keeping
    // the old one is strictly better than storing nothing and locking the user
    // out on the next tick.
    if (tokens.refreshToken) {
      await saveBufferOAuthCredential(
        env.DB,
        userId,
        await sealSecret(tokens.refreshToken, env.ENCRYPTION_KEY),
        { scope: tokens.scope || current.scope },
      );
    }

    return { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds };
  };

  try {
    return await attempt(row);
  } catch (error) {
    if (!(error instanceof BufferOAuthError) || !error.needsReconnect) throw error;

    const latest = await getBufferOAuthCredential(env.DB, userId);
    if (!latest || latest.updated_at === row.updated_at) {
      throw new BufferOAuthError(
        'Buffer rejected the stored authorization. Sign in with Buffer again to reconnect.',
        true,
      );
    }

    // Someone else rotated while we were in flight. Their token is the live one.
    return attempt(latest);
  }
}

/**
 * Returns a Buffer access token for an OAuth user, refreshing when needed.
 *
 * Callers that already know the user is on OAuth can use this directly; most
 * should call `bufferTokenFor`, which handles both credential kinds.
 */
export async function bufferAccessToken(env: Env, userId: string): Promise<string> {
  const config = bufferOAuthConfig(env);
  if (!config) {
    throw new BufferOAuthError(
      'This deployment has no Buffer OAuth client configured, so a stored sign-in cannot be refreshed.',
      true,
    );
  }

  const cached = await env.FEED_CACHE.get(tokenKey(userId));
  if (cached) return cached;

  const row = await getBufferOAuthCredential(env.DB, userId);
  if (!row) throw new BufferOAuthError('Buffer is not connected for this account', true);

  // Advisory lock. A stale read here costs one redundant refresh, not
  // correctness — the retry path below is what keeps the rotation safe.
  const held = await env.FEED_CACHE.get(lockKey(userId));
  if (held) {
    for (let waited = 0; waited < LOCK_WAIT_MS; waited += LOCK_POLL_MS) {
      await sleep(LOCK_POLL_MS);
      const winner = await env.FEED_CACHE.get(tokenKey(userId));
      if (winner) return winner;
    }
  }

  await env.FEED_CACHE.put(lockKey(userId), '1', { expirationTtl: LOCK_TTL_SECONDS });

  try {
    const { accessToken, expiresInSeconds } = await refreshAndStore(env, userId, config, row);

    // Expire a minute early so a token never dies mid-run. KV's floor is 60s.
    await env.FEED_CACHE.put(tokenKey(userId), accessToken, {
      expirationTtl: Math.max(60, expiresInSeconds - 60),
    });

    return accessToken;
  } finally {
    await env.FEED_CACHE.delete(lockKey(userId));
  }
}

/**
 * The bearer token for this user, whichever way they connected.
 *
 * OAuth is checked first so that a user who upgrades from a pasted key is on
 * the better credential immediately, even if the old key row lingers.
 */
export async function bufferTokenFor(env: Env, userId: string): Promise<string> {
  if (await hasOAuthCredential(env, userId)) return bufferAccessToken(env, userId);

  const credential = await getCredential(env.DB, userId);
  if (!credential) {
    throw new BufferAuthError('No Buffer credential is stored for this account');
  }

  return openSecret({ ciphertext: credential.ciphertext, iv: credential.iv }, env.ENCRYPTION_KEY);
}

/** Drops the cached access token, e.g. after disconnecting or reconnecting. */
export async function invalidateAccessToken(env: Env, userId: string): Promise<void> {
  await env.FEED_CACHE.delete(tokenKey(userId));
}

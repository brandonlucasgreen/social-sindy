/**
 * Session handling and the short-lived caches that keep the setup UI from
 * spending Buffer quota on every page view.
 */

import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';

import { BufferClient } from './buffer/client.js';
import { bufferTokenFor } from './buffer/token.js';
import type { BufferAccount, BufferChannel } from './buffer/types.js';
import { createSession, getSessionUser, type UserRow } from './db.js';
import type { Env } from './env.js';

export const SESSION_COOKIE = 'socially_session';

export interface AppBindings {
  Bindings: Env;
  Variables: { user: UserRow | null };
}

export type AppContext = Context<AppBindings>;

/**
 * Navigating the setup flow would otherwise re-read the account and channel
 * list on every step. Buffer's 24-hour budget can be as low as 250 requests,
 * so these are cached briefly — short enough that a newly connected channel
 * shows up on a refresh.
 */
const LOOKUP_CACHE_SECONDS = 300;

export function setSessionCookie(c: AppContext, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 86_400,
  });
}

export function clearSessionCookie(c: AppContext): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function startSession(c: AppContext, userId: string): Promise<void> {
  setSessionCookie(c, await createSession(c.env.DB, userId));
}

/** Resolves the signed-in user, if any, for every request. */
export const withUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  c.set('user', sessionId ? await getSessionUser(c.env.DB, sessionId) : null);
  await next();
};

/** Guards authenticated pages, redirecting anonymous visitors to connect. */
export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!c.get('user')) return c.redirect('/', 302);
  await next();
};

/**
 * Builds a Buffer client from whichever credential the user connected with —
 * an OAuth access token, refreshed on demand, or a pasted personal API key.
 */
export async function clientForUser(env: Env, userId: string): Promise<BufferClient> {
  return new BufferClient(await bufferTokenFor(env, userId));
}

async function cached<T>(
  env: Env,
  key: string,
  load: () => Promise<T>,
  refresh: boolean,
): Promise<T> {
  if (!refresh) {
    const hit = await env.FEED_CACHE.get(key, 'json');
    if (hit) return hit as T;
  }
  const value = await load();
  await env.FEED_CACHE.put(key, JSON.stringify(value), {
    expirationTtl: LOOKUP_CACHE_SECONDS,
  });
  return value;
}

export function accountFor(env: Env, userId: string, refresh = false): Promise<BufferAccount> {
  return cached(
    env,
    `account:${userId}`,
    async () => {
      const client = await clientForUser(env, userId);
      return (await client.getAccount()).data;
    },
    refresh,
  );
}

export function channelsFor(
  env: Env,
  userId: string,
  organizationId: string,
  refresh = false,
): Promise<BufferChannel[]> {
  return cached(
    env,
    `channels:${userId}:${organizationId}`,
    async () => {
      const client = await clientForUser(env, userId);
      return (await client.getChannels(organizationId)).data;
    },
    refresh,
  );
}

/** Drops cached lookups, e.g. after the stored API key changes. */
export async function invalidateLookups(
  env: Env,
  userId: string,
  organizationIds: string[],
): Promise<void> {
  await Promise.all([
    env.FEED_CACHE.delete(`account:${userId}`),
    ...organizationIds.map((id) => env.FEED_CACHE.delete(`channels:${userId}:${id}`)),
  ]);
}

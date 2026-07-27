/**
 * The Buffer sign-in callback.
 *
 * The behaviour under test is the one that only shows up on the *second*
 * sign-in: an authorization server that has already recorded a user's approval
 * skips the approval screen and returns an access token with no refresh token.
 * The first sign-in therefore works, and every one after it — a new device, a
 * new browser, a cleared cookie — used to dead-end on "Buffer did not return a
 * durable authorization". Two things have to hold for that not to happen, and
 * both are exercised here: the consent screen is asked for, and a response
 * without a refresh token falls back to the grant already on file rather than
 * treating it as a failed sign-in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authRoutes } from '../src/routes/auth.jsx';
import { generateEncryptionKey, openSecret, sealSecret } from '../src/crypto.js';

const ACCOUNT = {
  id: 'acct-1',
  email: 'brandon@buffer.com',
  name: 'Brandon',
  timezone: 'Europe/London',
  organizations: [{ id: 'org-1', name: 'Cult of Lightbulbs' }],
};

function fakeKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string, type?: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    }),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  };
}

interface FakeUser {
  id: string;
  buffer_account_id: string;
  email: string;
  name: string | null;
  timezone: string;
  created_at: string;
  updated_at: string;
}

interface FakeOAuthRow {
  user_id: string;
  ciphertext: string;
  iv: string;
  scope: string;
  updated_at: string;
}

/**
 * In-memory stand-in for the four tables this route touches, dispatched on the
 * SQL the route actually issues. Deliberately not a SQL engine — the assertions
 * are about which rows exist afterwards, so the tables only have to be honest
 * about writes, not about parsing.
 */
function fakeD1() {
  const users = new Map<string, FakeUser>(); // keyed by buffer_account_id
  const oauth = new Map<string, FakeOAuthRow>(); // keyed by user_id
  const apiKeys = new Set<string>(); // user_ids holding a pasted key
  const sessions: { id: string; userId: string }[] = [];

  return {
    users,
    oauth,
    apiKeys,
    sessions,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes('FROM users WHERE buffer_account_id')) {
            return users.get(args[0] as string) ?? null;
          }
          if (sql.includes('FROM buffer_oauth_credentials WHERE user_id')) {
            return oauth.get(args[0] as string) ?? null;
          }
          return null;
        },
        run: async () => {
          if (sql.includes('INSERT INTO users')) {
            const [id, accountId, email, name, timezone, created] = args as string[];
            const existing = users.get(accountId!);
            users.set(accountId!, {
              id: existing?.id ?? id!,
              buffer_account_id: accountId!,
              email: email!,
              name: name ?? null,
              timezone: timezone!,
              created_at: existing?.created_at ?? created!,
              updated_at: created!,
            });
          } else if (sql.includes('INSERT INTO buffer_oauth_credentials')) {
            const [userId, ciphertext, iv, scope, created] = args as string[];
            oauth.set(userId!, {
              user_id: userId!,
              ciphertext: ciphertext!,
              iv: iv!,
              scope: scope!,
              updated_at: created!,
            });
          } else if (sql.includes('DELETE FROM credentials')) {
            apiKeys.delete(args[0] as string);
          } else if (sql.includes('INSERT INTO sessions')) {
            sessions.push({ id: args[0] as string, userId: args[1] as string });
          }
          return {};
        },
      }),
    }),
  };
}

const KEY = generateEncryptionKey();

function envWith(db: ReturnType<typeof fakeD1>, kv: ReturnType<typeof fakeKV>) {
  return {
    DB: db as never,
    FEED_CACHE: kv as never,
    ENCRYPTION_KEY: KEY,
    APP_BASE_URL: 'https://socialsindy.com',
    BUFFER_CLIENT_ID: 'client-abc',
    BUFFER_CLIENT_SECRET: 'secret-xyz',
  } as never;
}

/**
 * Answers both endpoints the callback touches: the token exchange and the
 * account read that follows it.
 */
function stubBuffer(token: Record<string, unknown>) {
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).includes('auth.buffer.com/token')) {
      return new Response(JSON.stringify(token), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ data: { account: ACCOUNT } }), {
      headers: { 'content-type': 'application/json' },
    });
  });
}

/** Parks a state record as `/auth/buffer` would have, and returns the state. */
async function parkState(kv: ReturnType<typeof fakeKV>, forceConsent = true) {
  const state = 'state-1';
  kv.store.set(`bstate:${state}`, JSON.stringify({ verifier: 'verifier-1', forceConsent }));
  return state;
}

function callback(query: string, env: ReturnType<typeof envWith>) {
  return authRoutes.request(`https://socialsindy.com/auth/callback?${query}`, {}, env);
}

describe('/auth/buffer', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('asks for the approval screen, which is what makes the grant durable', async () => {
    const kv = fakeKV();
    const response = await authRoutes.request(
      'https://socialsindy.com/auth/buffer',
      {},
      envWith(fakeD1(), kv),
    );

    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get('location')!);
    expect(redirect.origin + redirect.pathname).toBe('https://auth.buffer.com/auth');
    expect(redirect.searchParams.get('prompt')).toBe('consent');

    // The verifier is parked server-side, never handed to the browser.
    const state = redirect.searchParams.get('state')!;
    const parked = JSON.parse(kv.store.get(`bstate:${state}`)!);
    expect(parked.forceConsent).toBe(true);
    expect(response.headers.get('location')).not.toContain(parked.verifier);
  });
});

describe('/auth/callback — a repeat sign-in with no refresh token', () => {
  beforeEach(() => vi.restoreAllMocks());

  /** A user who signed in before, with a live grant already stored. */
  async function seedReturningUser(db: ReturnType<typeof fakeD1>) {
    const sealed = await sealSecret('rt-live', KEY);
    db.users.set(ACCOUNT.id, {
      id: 'usr-1',
      buffer_account_id: ACCOUNT.id,
      email: ACCOUNT.email,
      name: ACCOUNT.name,
      timezone: 'UTC',
      created_at: 'T0',
      updated_at: 'T0',
    });
    db.oauth.set('usr-1', {
      user_id: 'usr-1',
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      scope: 'account:read posts:read offline_access',
      updated_at: 'T0',
    });
  }

  // The reported failure: signing in on a second device refused to complete,
  // even though the account's grant was healthy and the calendar was updating.
  it('signs the user in against the grant already on file', async () => {
    const db = fakeD1();
    const kv = fakeKV();
    await seedReturningUser(db);
    stubBuffer({ access_token: 'at-1', expires_in: 3600 }); // no refresh_token
    const state = await parkState(kv);

    const response = await callback(`state=${state}&code=code-1`, envWith(db, kv));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/sindies');
    expect(db.sessions).toHaveLength(1);
    expect(db.sessions[0]!.userId).toBe('usr-1');
  });

  // Storing nothing over a live grant, or clearing the cached access token for
  // a rotation that did not happen, would break the account this path exists to
  // rescue.
  it('leaves the stored grant exactly as it found it', async () => {
    const db = fakeD1();
    const kv = fakeKV();
    await seedReturningUser(db);
    kv.store.set('btoken:usr-1', 'cached-at');
    stubBuffer({ access_token: 'at-1', expires_in: 3600 });
    const state = await parkState(kv);

    await callback(`state=${state}&code=code-1`, envWith(db, kv));

    const stored = db.oauth.get('usr-1')!;
    expect(await openSecret({ ciphertext: stored.ciphertext, iv: stored.iv }, KEY)).toBe('rt-live');
    expect(stored.updated_at).toBe('T0');
    expect(kv.store.get('btoken:usr-1')).toBe('cached-at');
  });

  // With nothing on file there is genuinely no way to keep the calendar fresh,
  // so this must still fail — and must not leave a user row with no credential.
  it('still refuses when there is no grant to fall back on', async () => {
    const db = fakeD1();
    const kv = fakeKV();
    stubBuffer({ access_token: 'at-1', expires_in: 3600 });
    const state = await parkState(kv);

    const response = await callback(`state=${state}&code=code-1`, envWith(db, kv));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('did not return a durable authorization');
    expect(db.users.size).toBe(0);
    expect(db.sessions).toHaveLength(0);
  });
});

describe('/auth/callback — a first sign-in', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('stores the refresh token and drops any pasted key', async () => {
    const db = fakeD1();
    const kv = fakeKV();
    db.users.set(ACCOUNT.id, {
      id: 'usr-1',
      buffer_account_id: ACCOUNT.id,
      email: ACCOUNT.email,
      name: ACCOUNT.name,
      timezone: 'UTC',
      created_at: 'T0',
      updated_at: 'T0',
    });
    db.apiKeys.add('usr-1');
    stubBuffer({ access_token: 'at-1', refresh_token: 'rt-new', expires_in: 3600 });
    const state = await parkState(kv);

    const response = await callback(`state=${state}&code=code-1`, envWith(db, kv));

    expect(response.headers.get('location')).toBe('/sindies');
    const stored = db.oauth.get('usr-1')!;
    expect(await openSecret({ ciphertext: stored.ciphertext, iv: stored.iv }, KEY)).toBe('rt-new');
    // A full-access key must not linger once a read-only grant exists.
    expect(db.apiKeys.has('usr-1')).toBe(false);
  });

  it('consumes the state, so a replayed callback cannot re-run the exchange', async () => {
    const db = fakeD1();
    const kv = fakeKV();
    stubBuffer({ access_token: 'at-1', refresh_token: 'rt-new', expires_in: 3600 });
    const state = await parkState(kv);

    await callback(`state=${state}&code=code-1`, envWith(db, kv));
    const replay = await callback(`state=${state}&code=code-1`, envWith(db, kv));

    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain('expired or was already used');
  });
});

describe('/auth/callback — an error redirect', () => {
  beforeEach(() => vi.restoreAllMocks());

  // `prompt` cannot be exercised outside the deployed origin. If Buffer turns
  // out not to accept it, the cost must be one wasted redirect rather than a
  // sign-in nobody can complete.
  it('retries without prompt when the server rejects the parameter', async () => {
    const kv = fakeKV();
    const state = await parkState(kv, true);

    const response = await callback(`state=${state}&error=invalid_request`, envWith(fakeD1(), kv));

    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get('location')!);
    expect(redirect.origin).toBe('https://auth.buffer.com');
    expect(redirect.searchParams.has('prompt')).toBe(false);
  });

  it('does not retry a second time, so a rejection cannot loop', async () => {
    const kv = fakeKV();
    const state = await parkState(kv, false);

    const response = await callback(`state=${state}&error=invalid_request`, envWith(fakeD1(), kv));

    expect(response.status).toBe(400);
  });

  it('shows a genuine refusal rather than silently retrying it', async () => {
    const kv = fakeKV();
    const state = await parkState(kv, true);

    const response = await callback(`state=${state}&error=access_denied`, envWith(fakeD1(), kv));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('You declined the Buffer authorization');
  });
});

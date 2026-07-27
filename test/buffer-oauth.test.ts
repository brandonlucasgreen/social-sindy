import { describe, expect, it, vi, beforeEach } from 'vitest';

import { bufferOAuthConfig } from '../src/buffer/config.js';
import {
  authorizationUrl,
  BUFFER_SCOPES,
  BufferOAuthError,
  createPkcePair,
  describeAuthorizationError,
  exchangeCode,
  hasRequiredScopes,
  promptRejected,
  refreshAccessToken,
  type BufferOAuthConfig,
} from '../src/buffer/oauth.js';
import { bufferTokenFor, invalidateAccessToken } from '../src/buffer/token.js';
import { generateEncryptionKey, openSecret, sealSecret } from '../src/crypto.js';

const CONFIG: BufferOAuthConfig = {
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
  redirectUri: 'https://socialsindy.com/auth/callback',
};

describe('bufferOAuthConfig', () => {
  const base = { APP_BASE_URL: 'https://socialsindy.com' } as never;

  it('is null without a client id, so the app falls back to API keys', () => {
    expect(bufferOAuthConfig({ ...(base as object) } as never)).toBeNull();
  });

  it('works as a public client on PKCE alone, with no secret', () => {
    const config = bufferOAuthConfig({ ...(base as object), BUFFER_CLIENT_ID: 'abc' } as never);
    expect(config).not.toBeNull();
    expect(config!.clientSecret).toBeUndefined();
  });

  it('derives the redirect from APP_BASE_URL and tolerates a trailing slash', () => {
    const config = bufferOAuthConfig({
      APP_BASE_URL: 'https://socialsindy.com/',
      BUFFER_CLIENT_ID: 'abc',
    } as never);
    expect(config!.redirectUri).toBe('https://socialsindy.com/auth/callback');
  });
});

describe('authorizationUrl', () => {
  it('requests read-only scopes and never a write scope', () => {
    const url = new URL(authorizationUrl(CONFIG, 'state123', 'challenge123'));
    const scopes = url.searchParams.get('scope')!.split(' ');

    expect(scopes).toContain('account:read');
    expect(scopes).toContain('posts:read');
    expect(scopes).toContain('offline_access');
    // The homepage promises the tool never publishes; asking for write access
    // would make that promise false at the consent screen.
    expect(scopes).not.toContain('posts:write');
    expect(scopes).not.toContain('ideas:write');
  });

  it('sends PKCE with S256, never plain', () => {
    const url = new URL(authorizationUrl(CONFIG, 'state123', 'challenge123'));
    expect(url.searchParams.get('code_challenge')).toBe('challenge123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('never puts the client secret in the redirect the browser follows', () => {
    const url = authorizationUrl(CONFIG, 'state123', 'challenge123');
    expect(url).not.toContain('secret-xyz');
  });

  // Without this, an already-approved user is sent straight past the approval
  // screen and Buffer returns no refresh token — so the FIRST sign-in works and
  // every one after it fails. Signing in on a second device is the usual way to
  // discover that.
  it('forces the approval screen, so a repeat sign-in still yields a refresh token', () => {
    const url = new URL(authorizationUrl(CONFIG, 's', 'c', { forceConsent: true }));
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('omits prompt when consent is not forced, leaving the retry path clean', () => {
    for (const url of [
      authorizationUrl(CONFIG, 's', 'c'),
      authorizationUrl(CONFIG, 's', 'c', { forceConsent: false }),
    ]) {
      expect(new URL(url).searchParams.has('prompt')).toBe(false);
    }
  });
});

describe('promptRejected', () => {
  // `prompt` cannot be exercised outside the deployed origin, so the retry it
  // guards is the difference between "one wasted redirect" and "nobody can sign
  // in" if Buffer turns out not to accept it.
  it('recognises a server objecting to the parameter', () => {
    expect(promptRejected('invalid_request')).toBe(true);
    expect(promptRejected('invalid_request', 'Unsupported parameter')).toBe(true);
    expect(promptRejected('server_error', 'prompt is not supported')).toBe(true);
  });

  it('does not mistake a real refusal for a bad parameter', () => {
    expect(promptRejected('access_denied')).toBe(false);
    expect(promptRejected('server_error')).toBe(false);
    expect(
      promptRejected('server_error', 'Please stop impersonation first.'),
    ).toBe(false);
  });
});

describe('createPkcePair', () => {
  it('produces a url-safe verifier and a different challenge', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it('is different every time', async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('describeAuthorizationError', () => {
  it('surfaces error_description, which is the only informative part', () => {
    // Real example: Buffer blocks OAuth while a staff impersonation session is
    // active. The code alone ("server_error") is unactionable.
    expect(
      describeAuthorizationError(
        'server_error',
        'You cannot sign in to the new authorization system while impersonating in the old authorization system. Please stop impersonation first.',
      ),
    ).toContain('stop impersonation first');
  });

  it('falls back to the code when no description is given', () => {
    expect(describeAuthorizationError('server_error')).toContain('(server_error)');
    expect(describeAuthorizationError('server_error', '   ')).toContain('(server_error)');
    expect(describeAuthorizationError('server_error', null)).toContain('(server_error)');
  });

  it('never renders an empty reason', () => {
    for (const [code, desc] of [['server_error', undefined], ['x', ''], ['y', null]] as const) {
      expect(describeAuthorizationError(code, desc).trim()).not.toMatch(/[:(]\s*\)?$/);
    }
  });

  it('keeps the plain-language message for a genuine refusal', () => {
    expect(describeAuthorizationError('access_denied')).toBe(
      'You declined the Buffer authorization, so nothing was connected.',
    );
  });
});

describe('hasRequiredScopes', () => {
  it('accepts a grant covering account and posts', () => {
    expect(hasRequiredScopes('account:read posts:read offline_access')).toBe(true);
  });

  it('rejects an explicitly downgraded grant', () => {
    expect(hasRequiredScopes('account:read')).toBe(false);
    expect(hasRequiredScopes('posts:read')).toBe(false);
  });

  // RFC 6749 §5.1: scope is OPTIONAL in the response when identical to the
  // request. Treating absence as "granted nothing" would refuse a good
  // authorization and tell the user they declined what they just approved.
  it('treats an absent scope as granted-as-requested, not as empty', () => {
    expect(hasRequiredScopes(null)).toBe(true);
    expect(hasRequiredScopes(undefined)).toBe(true);
    expect(hasRequiredScopes('')).toBe(true);
    expect(hasRequiredScopes('   ')).toBe(true);
  });

  it('tolerates comma delimiters, since providers are inconsistent', () => {
    expect(hasRequiredScopes('account:read,posts:read,offline_access')).toBe(true);
    expect(hasRequiredScopes('account:read, posts:read')).toBe(true);
  });
});

describe('token response scope normalisation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reports an omitted or blank scope as null rather than an empty string', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ access_token: 'at', refresh_token: 'rt' }));
    expect((await exchangeCode(CONFIG, 'c', 'v')).scope).toBeNull();

    vi.stubGlobal('fetch', async () =>
      jsonResponse({ access_token: 'at', refresh_token: 'rt', scope: '  ' }),
    );
    expect((await exchangeCode(CONFIG, 'c', 'v')).scope).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('token exchange', () => {
  beforeEach(() => vi.restoreAllMocks());

  /** Captures the form body of the token request the call under test made. */
  function captureTokenPost(response: Response) {
    const sent: URLSearchParams[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body?: unknown }) => {
      sent.push(new URLSearchParams(String(init.body)));
      return response;
    });
    return () => {
      const first = sent[0];
      if (!first) throw new Error('no token request was made');
      return first;
    };
  }

  it('sends the verifier and the secret to the token endpoint', async () => {
    const sent = captureTokenPost(
      jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'posts:read' }),
    );

    const tokens = await exchangeCode(CONFIG, 'code-1', 'verifier-1');

    expect(sent().get('code_verifier')).toBe('verifier-1');
    expect(sent().get('client_secret')).toBe('secret-xyz');
    expect(sent().get('grant_type')).toBe('authorization_code');
    expect(tokens.refreshToken).toBe('rt');
  });

  it('omits client_secret for a public client', async () => {
    const sent = captureTokenPost(jsonResponse({ access_token: 'at' }));

    await exchangeCode({ ...CONFIG, clientSecret: undefined }, 'code-1', 'v');

    expect(sent().has('client_secret')).toBe(false);
  });

  it('flags invalid_grant as needing a reconnect, and other errors as transient', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(refreshAccessToken(CONFIG, 'rt')).rejects.toMatchObject({ needsReconnect: true });

    vi.stubGlobal('fetch', async () => new Response('boom', { status: 503 }));
    await expect(refreshAccessToken(CONFIG, 'rt')).rejects.toMatchObject({ needsReconnect: false });
  });

  it('treats a missing access token as an error rather than returning undefined', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ refresh_token: 'rt' }));
    await expect(exchangeCode(CONFIG, 'c', 'v')).rejects.toBeInstanceOf(BufferOAuthError);
  });
});

// --- the rotation race ------------------------------------------------------

/**
 * Minimal in-memory stand-ins. The point of these tests is the interaction
 * between the KV cache, the D1 row, and Buffer rotating the refresh token, so
 * the fakes only need to model those three things honestly.
 */
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

/**
 * One user, one OAuth row, addressed by the queries token.ts actually issues.
 *
 * The insert applies the real bound parameters rather than a canned value, so
 * "did it persist the rotated token" is genuinely observed and not assumed.
 */
function fakeDB(row: Record<string, unknown> | null) {
  let current = row;
  let writes = 0;

  return {
    current: () => current,
    writes: () => writes,
    /** Simulates another request committing a rotation while we are in flight. */
    rotateExternally(ciphertext: string, iv: string, updatedAt: string) {
      current = { ...(current as object), ciphertext, iv, updated_at: updatedAt };
    },
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => (sql.includes('buffer_oauth_credentials') ? current : null),
        run: async () => {
          if (sql.includes('INSERT INTO buffer_oauth_credentials')) {
            const [, ciphertext, iv, scope, , updatedAt] = args;
            current = { ...(current as object), ciphertext, iv, scope, updated_at: updatedAt };
            writes++;
          }
          return {};
        },
      }),
    }),
  };
}

describe('bufferTokenFor — refresh token rotation', () => {
  const KEY = generateEncryptionKey();

  beforeEach(() => vi.restoreAllMocks());

  async function envWith(refreshToken: string, updatedAt = 'T1') {
    const sealed = await sealSecret(refreshToken, KEY);
    const kv = fakeKV();
    const db = fakeDB({
      user_id: 'u1',
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      scope: 'account:read posts:read offline_access',
      updated_at: updatedAt,
    });
    return {
      env: {
        DB: db as never,
        FEED_CACHE: kv as never,
        ENCRYPTION_KEY: KEY,
        APP_BASE_URL: 'https://socialsindy.com',
        BUFFER_CLIENT_ID: 'client-abc',
        BUFFER_CLIENT_SECRET: 'secret-xyz',
      } as never,
      kv,
      db,
    };
  }

  it('persists the NEW refresh token, because Buffer invalidates the old one', async () => {
    const { env, db } = await envWith('rt-old');

    vi.stubGlobal('fetch', async () =>
      jsonResponse({ access_token: 'at-1', refresh_token: 'rt-new', expires_in: 3600, scope: 's' }),
    );

    const token = await bufferTokenFor(env, 'u1');
    expect(token).toBe('at-1');

    // The stored token must now decrypt to the rotated value, not the spent one.
    // Dropping this write works exactly once, then locks the user out.
    const stored = db.current() as { ciphertext: string; iv: string };
    expect(await openSecret({ ciphertext: stored.ciphertext, iv: stored.iv }, KEY)).toBe('rt-new');
    expect(db.writes()).toBe(1);
  });

  it('serves the cached access token without touching the network', async () => {
    const { env, kv } = await envWith('rt-old');
    kv.store.set('btoken:u1', 'cached-at');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await bufferTokenFor(env, 'u1')).toBe('cached-at');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovers when a concurrent refresh already rotated the token', async () => {
    // The scenario: we read row T1, but another request refreshed first and
    // stored T2. Buffer rejects our now-spent token with invalid_grant. Giving
    // up here would log out a user whose grant is perfectly healthy.
    const { env, db } = await envWith('rt-stale', 'T1');

    const winnerSealed = await sealSecret('rt-winner', KEY);
    let calls = 0;

    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls++;
      const sent = new URLSearchParams(init.body as string).get('refresh_token');

      if (sent === 'rt-stale') {
        // Buffer has already invalidated our token in favour of the winner's.
        // The winner's write lands in D1 at this moment — after we read the row,
        // before our retry re-reads it. That ordering is the whole race.
        db.rotateExternally(winnerSealed.ciphertext, winnerSealed.iv, 'T2');
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      }

      expect(sent).toBe('rt-winner');
      return jsonResponse({
        access_token: 'at-recovered',
        refresh_token: 'rt-final',
        expires_in: 3600,
        scope: 's',
      });
    });

    const token = await bufferTokenFor(env, 'u1');

    expect(token).toBe('at-recovered');
    expect(calls).toBe(2); // failed once, retried against the winner's token
  });

  it('gives up and asks for a reconnect when nobody else rotated', async () => {
    const { env } = await envWith('rt-dead', 'T1');

    vi.stubGlobal('fetch', async () => new Response('{"error":"invalid_grant"}', { status: 400 }));

    await expect(bufferTokenFor(env, 'u1')).rejects.toMatchObject({
      name: 'BufferOAuthError',
      needsReconnect: true,
    });
  });

  it('does not retry a transient failure as though it were a rotation conflict', async () => {
    const { env } = await envWith('rt-ok');

    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('upstream exploded', { status: 503 });
    });

    await expect(bufferTokenFor(env, 'u1')).rejects.toMatchObject({ needsReconnect: false });
    expect(calls).toBe(1);
  });
});

describe('invalidateAccessToken', () => {
  it('drops the cached token so the next call refreshes', async () => {
    const kv = fakeKV();
    kv.store.set('btoken:u1', 'stale');
    await invalidateAccessToken({ FEED_CACHE: kv } as never, 'u1');
    expect(kv.store.has('btoken:u1')).toBe(false);
  });
});

describe('BUFFER_SCOPES', () => {
  it('is read-only plus offline access, and nothing more', () => {
    expect([...BUFFER_SCOPES].sort()).toEqual(['account:read', 'offline_access', 'posts:read']);
  });
});

/**
 * Buffer OAuth 2.0 (authorization code + PKCE).
 *
 * Buffer's OAuth is real and works, despite `developers.buffer.com`'s OAuth
 * guide returning 404 — the endpoints below are the ones its own first-party
 * clients use. It requires a public HTTPS redirect URI, so this cannot be
 * exercised from plain localhost; the deployed origin is the only way to test.
 *
 * The scopes requested are read-only on purpose. A personal API key grants full
 * account access including publishing, which is far more than a calendar needs
 * and more than the interface promises. `offline_access` is what makes the
 * background push possible at all.
 *
 * THE ROTATION TRAP: Buffer issues a NEW refresh token on every refresh and
 * invalidates the old one. Callers must persist what comes back. Two concurrent
 * refreshes will invalidate each other, which is why `token.ts` serialises them
 * and retries against the freshly stored token rather than giving up.
 */

const AUTH_ENDPOINT = 'https://auth.buffer.com/auth';
const TOKEN_ENDPOINT = 'https://auth.buffer.com/token';

/**
 * Least privilege for a read-only calendar tool.
 *
 * Deliberately omits `posts:write` and `ideas:write`, which Buffer's own
 * clients request — nothing here ever creates or edits a post, and asking for
 * write access would contradict the "Never publishes" promise on the homepage.
 */
export const BUFFER_SCOPES = ['account:read', 'posts:read', 'offline_access'];

export class BufferOAuthError extends Error {
  constructor(
    message: string,
    /** True when the grant is definitively dead and the user must reconnect. */
    readonly needsReconnect = false,
  ) {
    super(message);
    this.name = 'BufferOAuthError';
  }
}

export interface BufferOAuthConfig {
  clientId: string;
  /**
   * Optional. Buffer accepts public clients using PKCE alone, but a Worker can
   * hold a secret, so a confidential client is preferred where one is
   * registered. PKCE is sent either way.
   */
  clientSecret?: string;
  redirectUri: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier) as BufferSource,
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Builds the consent URL the user is sent to. */
export function authorizationUrl(
  config: BufferOAuthConfig,
  state: string,
  challenge: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: BUFFER_SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface BufferTokenResponse {
  accessToken: string;
  /** Null only if Buffer declines to issue one, which means no background sync. */
  refreshToken: string | null;
  expiresInSeconds: number;
  /** Null when Buffer omitted it, which per RFC 6749 means "as requested". */
  scope: string | null;
}

async function postToken(
  body: URLSearchParams,
  config: BufferOAuthConfig,
): Promise<BufferTokenResponse> {
  if (config.clientSecret) body.set('client_secret', config.clientSecret);

  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
  } catch (cause) {
    throw new BufferOAuthError(`Could not reach Buffer: ${String(cause)}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // `invalid_grant` means the code or refresh token is spent, revoked, or was
    // rotated out from under us. Everything else may be transient and must not
    // log the user out.
    const dead = response.status === 400 && /invalid_grant/i.test(detail);
    throw new BufferOAuthError(
      `Buffer token request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      dead,
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!data.access_token) throw new BufferOAuthError('Buffer returned no access token');

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresInSeconds: data.expires_in ?? 3600,
    scope: data.scope?.trim() || null,
  };
}

export function exchangeCode(
  config: BufferOAuthConfig,
  code: string,
  verifier: string,
): Promise<BufferTokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: config.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
    config,
  );
}

/**
 * Exchanges a refresh token for a fresh access token.
 *
 * The returned `refreshToken` REPLACES the stored one. Dropping it on the floor
 * works exactly once and then locks the user out, which is the kind of bug that
 * only shows up in production an hour after deploy.
 */
export function refreshAccessToken(
  config: BufferOAuthConfig,
  refreshToken: string,
): Promise<BufferTokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: config.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    config,
  );
}

/**
 * Turns an OAuth error redirect into something a person can act on.
 *
 * `error` is a fixed machine code from a short list; `error_description` is
 * where providers put the actual diagnosis, and it is frequently the only
 * informative part. Buffer, for example, uses it to explain that an active
 * staff impersonation session blocks sign-in — a cause no user would guess
 * from the code alone. Prefer the description, fall back to the code, and
 * never show nothing.
 */
export function describeAuthorizationError(
  error: string,
  description?: string | null,
): string {
  if (error === 'access_denied') {
    return 'You declined the Buffer authorization, so nothing was connected.';
  }

  const detail = description?.trim();
  return `Buffer refused the authorization${detail ? `: ${detail}` : ` (${error})`}`;
}

/**
 * True when the granted scopes cover what the calendar needs to read.
 *
 * **Absent means granted.** RFC 6749 §5.1 makes `scope` optional in a token
 * response when it is identical to what was requested, so plenty of providers
 * omit it entirely. Treating a missing value as "granted nothing" would reject
 * a perfectly good authorization and tell the user they declined permissions
 * they had just approved — a failure with no plausible diagnosis from the
 * outside. Only an explicitly-returned, explicitly-insufficient scope is a
 * refusal.
 *
 * Delimiter is whitespace per the spec, but commas are tolerated because
 * providers are inconsistent about it and a false rejection is expensive.
 */
export function hasRequiredScopes(scope: string | null | undefined): boolean {
  if (!scope || !scope.trim()) return true;

  const granted = new Set(scope.split(/[\s,]+/).filter(Boolean));
  return granted.has('account:read') && granted.has('posts:read');
}

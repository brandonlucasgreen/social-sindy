/**
 * Google OAuth 2.0 (authorization code + PKCE) for Calendar push.
 *
 * Requests exactly one scope: `calendar.app.created`, which grants "make
 * secondary Google calendars, and see, create, change, and delete events on
 * them". That is the narrowest scope that does the job — the app cannot see or
 * touch any calendar it did not create, including the user's primary one.
 *
 * Only the refresh token is persisted (encrypted). Access tokens are cached in
 * KV under their own expiry so they never reach the database.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * The only Calendar scope requested. `openid`/`email` are included solely so we
 * can label the connection in the UI with the account the user picked.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.app.created',
  'openid',
  'email',
];

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    /** True when the grant is definitively dead and the user must reconnect. */
    readonly needsReconnect = false,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
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
  config: GoogleOAuthConfig,
  state: string,
  challenge: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Required to receive a refresh token at all.
    access_type: 'offline',
    // Google only returns a refresh token on first consent unless forced, and a
    // background sync is useless without one.
    prompt: 'consent',
    include_granted_scopes: 'true',
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
}

async function postToken(
  config: GoogleOAuthConfig,
  body: URLSearchParams,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
  } catch (cause) {
    throw new GoogleAuthError(`Could not reach Google: ${String(cause)}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // `invalid_grant` means the refresh token was revoked or expired. Anything
    // else may be transient, and must not log the user out.
    const dead = response.status === 400 && /invalid_grant/i.test(detail);
    throw new GoogleAuthError(
      `Google token request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      dead,
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!data.access_token) throw new GoogleAuthError('Google returned no access token');

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresInSeconds: data.expires_in ?? 3600,
    scope: data.scope ?? '',
  };
}

export function exchangeCode(
  config: GoogleOAuthConfig,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  return postToken(
    config,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  );
}

/**
 * Exchanges a refresh token for a fresh access token.
 *
 * Unlike Buffer, Google does not rotate refresh tokens on use, so the stored
 * token stays valid and there is no write-back race to guard against.
 */
export function refreshAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  return postToken(
    config,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
}

/** Reads the connected account's email, purely to label it in the UI. */
export async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { email?: string };
    return data.email ?? null;
  } catch {
    return null;
  }
}

/** True when the granted scopes still include what push requires. */
export function hasCalendarScope(scope: string): boolean {
  return scope.split(/\s+/).includes('https://www.googleapis.com/auth/calendar.app.created');
}

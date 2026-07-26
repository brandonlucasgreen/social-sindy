import type { Env } from '../env.js';
import type { BufferOAuthConfig } from './oauth.js';

/**
 * Resolves the Buffer OAuth client from the environment, or null when this
 * deployment has not registered one.
 *
 * Null is a supported state, not a misconfiguration: without a client the
 * connect page falls back to a pasted personal API key, which is how every
 * existing account got here. Only `BUFFER_CLIENT_ID` is required — Buffer
 * accepts public clients on PKCE alone, so a deployment without a secret still
 * gets OAuth rather than being silently downgraded to the key form.
 */
export function bufferOAuthConfig(env: Env): BufferOAuthConfig | null {
  if (!env.BUFFER_CLIENT_ID) return null;

  return {
    clientId: env.BUFFER_CLIENT_ID,
    clientSecret: env.BUFFER_CLIENT_SECRET,
    // Must match the redirect registered with Buffer exactly, which is why it
    // is derived from APP_BASE_URL rather than from the incoming request: a
    // request arriving on some other hostname must not silently change it.
    redirectUri: `${env.APP_BASE_URL.replace(/\/$/, '')}/auth/callback`,
  };
}

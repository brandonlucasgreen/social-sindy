import type { Env } from '../env.js';
import type { GoogleOAuthConfig } from '../google/oauth.js';

/**
 * Resolves the Google OAuth client from the environment, or null when this
 * deployment has not configured one.
 *
 * Google push is optional: without credentials the rest of the app — the ICS
 * feed, which is the core product — must keep working, and the UI simply omits
 * the push controls rather than offering something that would fail.
 */
export function googleConfig(env: Env): GoogleOAuthConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.APP_BASE_URL.replace(/\/$/, '')}/google/callback`,
  };
}

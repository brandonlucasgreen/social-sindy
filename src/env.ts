export interface Env {
  DB: D1Database;
  /** Caches rendered feeds so client polls don't each spend Buffer quota. */
  FEED_CACHE: KVNamespace;
  /** Public origin, used to build the feed URLs shown to the user. */
  APP_BASE_URL: string;
  /** Base64 32-byte AES-256-GCM key that wraps stored Buffer API keys. */
  ENCRYPTION_KEY: string;
  /**
   * Buffer OAuth client for "Sign in with Buffer". Optional: without a client
   * the connect page falls back to a pasted personal API key. Only the ID is
   * required — Buffer accepts public clients on PKCE alone — but a Worker can
   * hold a secret, so a confidential client is preferred where registered.
   */
  BUFFER_CLIENT_ID?: string;
  BUFFER_CLIENT_SECRET?: string;
  /**
   * Google OAuth client for the optional Calendar push. Both may be absent: the
   * ICS feed is the core product and must work without them, and the UI omits
   * the push controls when they are unset.
   */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export interface Env {
  DB: D1Database;
  /** Caches rendered feeds so client polls don't each spend Buffer quota. */
  FEED_CACHE: KVNamespace;
  /** Public origin, used to build the feed URLs shown to the user. */
  APP_BASE_URL: string;
  /** Base64 32-byte AES-256-GCM key that wraps stored Buffer API keys. */
  ENCRYPTION_KEY: string;
}

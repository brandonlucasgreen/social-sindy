-- Users are identified by their Buffer account, since connecting Buffer is also
-- how they sign in. There is no separate password or identity provider.
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  buffer_account_id TEXT NOT NULL UNIQUE,
  email             TEXT NOT NULL,
  name              TEXT,
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- A user's Buffer API key, encrypted with AES-256-GCM. The plaintext key never
-- touches this table, logs, or any response body. `fingerprint` is a SHA-256
-- prefix, so we can tell whether a re-submitted key differs without decrypting.
CREATE TABLE credentials (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- One subscribable calendar feed: an organization, a set of channels, and the
-- rendering options. `feed_token` is the unguessable secret in the public URL.
CREATE TABLE calendars (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id        TEXT NOT NULL,
  organization_name      TEXT NOT NULL,
  name                   TEXT NOT NULL,
  feed_token             TEXT NOT NULL UNIQUE,
  -- Buffer posts carry a single `dueAt` instant with no duration, so events are
  -- rendered as a fixed-length block the user chooses.
  event_duration_minutes INTEGER NOT NULL DEFAULT 15,
  -- Advertised to calendar clients via X-PUBLISHED-TTL / REFRESH-INTERVAL, and
  -- used as the minimum interval between real Buffer fetches.
  refresh_minutes        INTEGER NOT NULL DEFAULT 60,
  window_past_days       INTEGER NOT NULL DEFAULT 30,
  window_future_days     INTEGER NOT NULL DEFAULT 90,
  -- Comma-separated Buffer post statuses to include.
  statuses               TEXT NOT NULL DEFAULT 'scheduled,sent',
  show_channel_in_title  INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  -- Observability for the feed, so the dashboard can show real sync state.
  last_polled_at         TEXT,
  last_fetched_at        TEXT,
  last_event_count       INTEGER,
  last_error             TEXT
);

CREATE INDEX idx_calendars_user ON calendars(user_id);

-- Channel names are denormalized so the feed can title events without spending
-- an extra Buffer request to resolve channel IDs on every poll.
CREATE TABLE calendar_channels (
  calendar_id  TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  channel_id   TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  service      TEXT NOT NULL,
  PRIMARY KEY (calendar_id, channel_id)
);

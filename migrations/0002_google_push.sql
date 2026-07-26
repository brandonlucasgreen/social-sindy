-- Google Calendar push: writes events directly into a dedicated Google calendar
-- so changes land in minutes, which a subscribed ICS feed cannot do.

-- Only the refresh token is stored. Access tokens are short-lived and cached in
-- KV instead, so they never sit in the database.
CREATE TABLE google_credentials (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ciphertext   TEXT NOT NULL,
  iv           TEXT NOT NULL,
  -- Which Google account was connected, so the UI can show it and detect a swap.
  google_email TEXT,
  -- Granted scopes, recorded so we can detect a downgrade at consent time.
  scope        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- The Google calendar we created for this feed. Null until push is enabled.
ALTER TABLE calendars ADD COLUMN google_calendar_id TEXT;
ALTER TABLE calendars ADD COLUMN push_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calendars ADD COLUMN last_push_at TEXT;
ALTER TABLE calendars ADD COLUMN last_push_error TEXT;
-- JSON {created,updated,deleted,skipped} from the most recent run, for the UI.
ALTER TABLE calendars ADD COLUMN last_push_stats TEXT;

-- The scheduler scans for calendars whose push is due.
CREATE INDEX idx_calendars_push ON calendars(push_enabled, last_push_at);

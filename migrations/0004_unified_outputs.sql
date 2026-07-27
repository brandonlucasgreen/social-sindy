-- Unified outputs table: replaces calendars/calendar_channels and feeds/feed_channels.
-- Pre-launch: no real data to preserve, so clean drop-and-create is fine.

DROP TABLE IF EXISTS calendar_channels;
DROP TABLE IF EXISTS calendars;
DROP TABLE IF EXISTS feed_channels;
DROP TABLE IF EXISTS feeds;

-- One Buffer org + channel selection → one feed URL.
-- format is 'ics' or 'atom' (extensible later).
CREATE TABLE outputs (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id        TEXT NOT NULL,
  organization_name      TEXT NOT NULL,
  name                   TEXT NOT NULL,
  format                 TEXT NOT NULL DEFAULT 'ics',  -- 'ics' | 'atom'
  feed_token             TEXT NOT NULL UNIQUE,
  -- ICS-specific fields (used when format = 'ics')
  event_duration_minutes INTEGER NOT NULL DEFAULT 15,
  show_channel_in_title  INTEGER NOT NULL DEFAULT 1,
  -- Atom-specific fields (used when format = 'atom')
  max_items              INTEGER NOT NULL DEFAULT 50,
  group_cross_posts      INTEGER NOT NULL DEFAULT 1,
  -- Shared fields
  refresh_minutes        INTEGER NOT NULL DEFAULT 60,
  window_past_days       INTEGER NOT NULL DEFAULT 30,
  window_future_days     INTEGER NOT NULL DEFAULT 90,
  statuses               TEXT NOT NULL DEFAULT 'scheduled,sent',
  -- Google Calendar push (ICS only, kept for ICS outputs)
  google_calendar_id     TEXT,
  push_enabled           INTEGER NOT NULL DEFAULT 0,
  last_push_at           TEXT,
  last_push_error        TEXT,
  last_push_stats        TEXT,
  -- Observability
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  last_polled_at         TEXT,
  last_fetched_at        TEXT,
  last_event_count       INTEGER,
  last_error             TEXT
);

CREATE INDEX idx_outputs_user ON outputs(user_id);

CREATE TABLE output_channels (
  output_id    TEXT NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  channel_id   TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  service      TEXT NOT NULL,
  PRIMARY KEY (output_id, channel_id)
);
/**
 * D1 data access. Thin, explicit SQL rather than an ORM — the schema is small
 * and the query shapes matter for a Worker's latency budget.
 */

import { randomId, randomToken } from './crypto.js';
import { isPostStatus, type PostStatus } from './buffer/types.js';

export interface UserRow {
  id: string;
  buffer_account_id: string;
  email: string;
  name: string | null;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface CredentialRow {
  user_id: string;
  ciphertext: string;
  iv: string;
  fingerprint: string;
}

export interface CalendarRow {
  id: string;
  user_id: string;
  organization_id: string;
  organization_name: string;
  name: string;
  feed_token: string;
  event_duration_minutes: number;
  refresh_minutes: number;
  window_past_days: number;
  window_future_days: number;
  statuses: string;
  show_channel_in_title: number;
  created_at: string;
  updated_at: string;
  last_polled_at: string | null;
  last_fetched_at: string | null;
  last_event_count: number | null;
  last_error: string | null;
  /** Set once the dedicated Google calendar has been created. */
  google_calendar_id: string | null;
  push_enabled: number;
  last_push_at: string | null;
  last_push_error: string | null;
  /** JSON {created,updated,deleted,unchanged} from the most recent run. */
  last_push_stats: string | null;
}

export interface CalendarChannelRow {
  calendar_id: string;
  channel_id: string;
  channel_name: string;
  service: string;
}

export interface CalendarWithChannels extends CalendarRow {
  channels: CalendarChannelRow[];
  /** Joined from the owning user, for stamping Google events with a zone. */
  user_timezone?: string;
}

export interface GoogleCredentialRow {
  user_id: string;
  ciphertext: string;
  iv: string;
  google_email: string | null;
  scope: string;
}

export interface BufferOAuthCredentialRow {
  user_id: string;
  ciphertext: string;
  iv: string;
  scope: string;
  /** Moves on every rotation; the conflict signal for a concurrent refresh. */
  updated_at: string;
}

const now = () => new Date().toISOString();

/** Statuses are stored comma-separated; unknown values are dropped on read. */
export function parseStatuses(value: string): PostStatus[] {
  const parsed = value
    .split(',')
    .map((s) => s.trim())
    .filter(isPostStatus);
  return parsed.length ? parsed : ['scheduled'];
}

export function serializeStatuses(statuses: PostStatus[]): string {
  return [...new Set(statuses)].join(',');
}

// -- users & credentials ----------------------------------------------------

export interface UpsertUserInput {
  bufferAccountId: string;
  email: string;
  name: string | null;
  timezone: string;
}

/**
 * Looks up the user for a Buffer account without creating one.
 *
 * Distinct from `upsertUser` because sign-in sometimes has to ask "do we
 * already know this account?" *before* deciding the sign-in can succeed, and
 * answering that question must not itself leave a half-made account behind.
 */
export function getUserByBufferAccountId(
  db: D1Database,
  bufferAccountId: string,
): Promise<UserRow | null> {
  return db
    .prepare('SELECT * FROM users WHERE buffer_account_id = ?')
    .bind(bufferAccountId)
    .first<UserRow>();
}

/**
 * Creates or refreshes the user for a Buffer account.
 *
 * Connecting Buffer is also how a user signs in, so a returning user must map
 * back to their existing row rather than creating a duplicate.
 */
export async function upsertUser(db: D1Database, input: UpsertUserInput): Promise<UserRow> {
  const timestamp = now();

  await db
    .prepare(
      `INSERT INTO users (id, buffer_account_id, email, name, timezone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(buffer_account_id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         timezone = excluded.timezone,
         updated_at = excluded.updated_at`,
    )
    .bind(
      randomId('usr'),
      input.bufferAccountId,
      input.email,
      input.name,
      input.timezone,
      timestamp,
      timestamp,
    )
    .run();

  const user = await db
    .prepare('SELECT * FROM users WHERE buffer_account_id = ?')
    .bind(input.bufferAccountId)
    .first<UserRow>();

  if (!user) throw new Error('Failed to persist user');
  return user;
}

export async function saveCredential(
  db: D1Database,
  userId: string,
  sealed: { ciphertext: string; iv: string },
  fingerprint: string,
): Promise<void> {
  const timestamp = now();
  await db
    .prepare(
      `INSERT INTO credentials (user_id, ciphertext, iv, fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         fingerprint = excluded.fingerprint,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, sealed.ciphertext, sealed.iv, fingerprint, timestamp, timestamp)
    .run();
}

export function getCredential(db: D1Database, userId: string): Promise<CredentialRow | null> {
  return db
    .prepare('SELECT user_id, ciphertext, iv, fingerprint FROM credentials WHERE user_id = ?')
    .bind(userId)
    .first<CredentialRow>();
}

/** Removes the user and everything belonging to them. */
export async function deleteUser(db: D1Database, userId: string): Promise<void> {
  // Deleted explicitly, in dependency order, rather than relying on D1 having
  // foreign-key enforcement switched on.
  await db.batch([
    db
      .prepare(
        'DELETE FROM calendar_channels WHERE calendar_id IN (SELECT id FROM calendars WHERE user_id = ?)',
      )
      .bind(userId),
    db.prepare('DELETE FROM calendars WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM credentials WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM buffer_oauth_credentials WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM google_credentials WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

// -- buffer oauth credentials -----------------------------------------------

/**
 * Stores or replaces the sealed Buffer refresh token.
 *
 * Called on every refresh, not just at connect time, because Buffer rotates the
 * token on use. `updated_at` always moves so a concurrent refresher can tell
 * that this row changed underneath it.
 */
export async function saveBufferOAuthCredential(
  db: D1Database,
  userId: string,
  sealed: { ciphertext: string; iv: string },
  details: { scope: string },
): Promise<void> {
  const timestamp = now();
  await db
    .prepare(
      `INSERT INTO buffer_oauth_credentials (user_id, ciphertext, iv, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         scope = excluded.scope,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, sealed.ciphertext, sealed.iv, details.scope, timestamp, timestamp)
    .run();
}

export function getBufferOAuthCredential(
  db: D1Database,
  userId: string,
): Promise<BufferOAuthCredentialRow | null> {
  return db
    .prepare(
      'SELECT user_id, ciphertext, iv, scope, updated_at FROM buffer_oauth_credentials WHERE user_id = ?',
    )
    .bind(userId)
    .first<BufferOAuthCredentialRow>();
}

export async function deleteBufferOAuthCredential(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db.prepare('DELETE FROM buffer_oauth_credentials WHERE user_id = ?').bind(userId).run();
}

/**
 * Drops a stored personal API key.
 *
 * Used when a user upgrades to OAuth: leaving the key behind would keep a
 * full-access credential at rest for an account that no longer needs one.
 */
export async function deleteCredential(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM credentials WHERE user_id = ?').bind(userId).run();
}

// -- google credentials -----------------------------------------------------

export async function saveGoogleCredential(
  db: D1Database,
  userId: string,
  sealed: { ciphertext: string; iv: string },
  details: { email: string | null; scope: string },
): Promise<void> {
  const timestamp = now();
  await db
    .prepare(
      `INSERT INTO google_credentials (user_id, ciphertext, iv, google_email, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         google_email = excluded.google_email,
         scope = excluded.scope,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, sealed.ciphertext, sealed.iv, details.email, details.scope, timestamp, timestamp)
    .run();
}

export function getGoogleCredential(
  db: D1Database,
  userId: string,
): Promise<GoogleCredentialRow | null> {
  return db
    .prepare(
      'SELECT user_id, ciphertext, iv, google_email, scope FROM google_credentials WHERE user_id = ?',
    )
    .bind(userId)
    .first<GoogleCredentialRow>();
}

/**
 * Disconnects Google and stops every push for this user.
 *
 * Push is disabled rather than left enabled-but-broken, so the scheduler does
 * not keep retrying a credential that is gone.
 */
export async function deleteGoogleCredential(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM google_credentials WHERE user_id = ?').bind(userId),
    db
      .prepare(
        `UPDATE calendars SET push_enabled = 0, google_calendar_id = NULL, last_push_error = NULL
         WHERE user_id = ?`,
      )
      .bind(userId),
  ]);
}

// -- push state -------------------------------------------------------------

export async function setPushEnabled(
  db: D1Database,
  calendarId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .prepare('UPDATE calendars SET push_enabled = ?, last_push_error = NULL, updated_at = ? WHERE id = ?')
    .bind(enabled ? 1 : 0, now(), calendarId)
    .run();
}

export async function setGoogleCalendarId(
  db: D1Database,
  calendarId: string,
  googleCalendarId: string,
): Promise<void> {
  await db
    .prepare('UPDATE calendars SET google_calendar_id = ? WHERE id = ?')
    .bind(googleCalendarId, calendarId)
    .run();
}

export async function clearGoogleCalendar(db: D1Database, calendarId: string): Promise<void> {
  await db
    .prepare('UPDATE calendars SET google_calendar_id = NULL WHERE id = ?')
    .bind(calendarId)
    .run();
}

export async function recordPush(
  db: D1Database,
  calendarId: string,
  outcome: {
    stats: { created: number; updated: number; deleted: number; unchanged: number } | null;
    error: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE calendars SET last_push_at = ?, last_push_stats = ?, last_push_error = ? WHERE id = ?`,
    )
    .bind(
      now(),
      outcome.stats ? JSON.stringify(outcome.stats) : null,
      outcome.error,
      calendarId,
    )
    .run();
}

/**
 * Calendars whose push is due, oldest first.
 *
 * The cron fires on a fixed interval; each calendar's own refresh setting
 * decides whether it is actually due, so a once-a-day calendar is not synced
 * every five minutes.
 */
export async function calendarsDueForPush(
  db: D1Database,
  now: Date,
  limit: number,
): Promise<CalendarWithChannels[]> {
  const { results } = await db
    .prepare(
      `SELECT calendars.*, users.timezone AS user_timezone FROM calendars
       JOIN users ON users.id = calendars.user_id
       WHERE calendars.push_enabled = 1
         AND calendars.google_calendar_id IS NOT NULL
         AND (
           calendars.last_push_at IS NULL
           OR julianday(?) - julianday(calendars.last_push_at) >= calendars.refresh_minutes / 1440.0
         )
       ORDER BY calendars.last_push_at IS NOT NULL, calendars.last_push_at ASC
       LIMIT ?`,
    )
    .bind(now.toISOString(), limit)
    .all<CalendarRow & { user_timezone: string }>();

  return attachChannels(db, results ?? []);
}

// -- sessions ---------------------------------------------------------------

const SESSION_TTL_DAYS = 30;

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const id = randomToken(32);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();

  await db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, now(), expires)
    .run();

  return id;
}

export function getSessionUser(db: D1Database, sessionId: string): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = ? AND sessions.expires_at > ?`,
    )
    .bind(sessionId, now())
    .first<UserRow>();
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

// -- calendars --------------------------------------------------------------

export interface CreateCalendarInput {
  userId: string;
  organizationId: string;
  organizationName: string;
  name: string;
  channels: { id: string; name: string; service: string }[];
  eventDurationMinutes: number;
  refreshMinutes: number;
  windowPastDays: number;
  windowFutureDays: number;
  statuses: PostStatus[];
  showChannelInTitle: boolean;
}

export async function createCalendar(
  db: D1Database,
  input: CreateCalendarInput,
): Promise<CalendarRow> {
  const id = randomId('cal');
  // 32 random bytes: the feed URL is unauthenticated, so the token is the only
  // thing standing between the URL and the post content behind it.
  const feedToken = randomToken(32);
  const timestamp = now();

  const statements = [
    db
      .prepare(
        `INSERT INTO calendars (
           id, user_id, organization_id, organization_name, name, feed_token,
           event_duration_minutes, refresh_minutes, window_past_days, window_future_days,
           statuses, show_channel_in_title, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.userId,
        input.organizationId,
        input.organizationName,
        input.name,
        feedToken,
        input.eventDurationMinutes,
        input.refreshMinutes,
        input.windowPastDays,
        input.windowFutureDays,
        serializeStatuses(input.statuses),
        input.showChannelInTitle ? 1 : 0,
        timestamp,
        timestamp,
      ),
    ...input.channels.map((channel) =>
      db
        .prepare(
          `INSERT INTO calendar_channels (calendar_id, channel_id, channel_name, service)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(id, channel.id, channel.name, channel.service),
    ),
  ];

  await db.batch(statements);

  const created = await db.prepare('SELECT * FROM calendars WHERE id = ?').bind(id).first<CalendarRow>();
  if (!created) throw new Error('Failed to persist calendar');
  return created;
}

async function attachChannels(
  db: D1Database,
  calendars: CalendarRow[],
): Promise<CalendarWithChannels[]> {
  if (!calendars.length) return [];

  const placeholders = calendars.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM calendar_channels WHERE calendar_id IN (${placeholders})`)
    .bind(...calendars.map((c) => c.id))
    .all<CalendarChannelRow>();

  const byCalendar = new Map<string, CalendarChannelRow[]>();
  for (const row of results ?? []) {
    const list = byCalendar.get(row.calendar_id) ?? [];
    list.push(row);
    byCalendar.set(row.calendar_id, list);
  }

  return calendars.map((calendar) => ({
    ...calendar,
    channels: byCalendar.get(calendar.id) ?? [],
  }));
}

export async function listCalendars(
  db: D1Database,
  userId: string,
): Promise<CalendarWithChannels[]> {
  const { results } = await db
    .prepare(
      `SELECT calendars.*, users.timezone AS user_timezone FROM calendars
       JOIN users ON users.id = calendars.user_id
       WHERE calendars.user_id = ? ORDER BY calendars.created_at DESC`,
    )
    .bind(userId)
    .all<CalendarRow>();

  return attachChannels(db, results ?? []);
}

export async function getCalendar(
  db: D1Database,
  calendarId: string,
  userId: string,
): Promise<CalendarWithChannels | null> {
  const calendar = await db
    .prepare(
      `SELECT calendars.*, users.timezone AS user_timezone FROM calendars
       JOIN users ON users.id = calendars.user_id
       WHERE calendars.id = ? AND calendars.user_id = ?`,
    )
    .bind(calendarId, userId)
    .first<CalendarRow>();

  if (!calendar) return null;
  return (await attachChannels(db, [calendar]))[0] ?? null;
}

/** Looks up a calendar by its public feed token, for the unauthenticated feed. */
export async function getCalendarByToken(
  db: D1Database,
  token: string,
): Promise<CalendarWithChannels | null> {
  const calendar = await db
    .prepare(
      `SELECT calendars.*, users.timezone AS user_timezone FROM calendars
       JOIN users ON users.id = calendars.user_id
       WHERE calendars.feed_token = ?`,
    )
    .bind(token)
    .first<CalendarRow>();

  if (!calendar) return null;
  return (await attachChannels(db, [calendar]))[0] ?? null;
}

export interface UpdateCalendarInput {
  name: string;
  channels: { id: string; name: string; service: string }[];
  eventDurationMinutes: number;
  refreshMinutes: number;
  windowPastDays: number;
  windowFutureDays: number;
  statuses: PostStatus[];
  showChannelInTitle: boolean;
}

export async function updateCalendar(
  db: D1Database,
  calendarId: string,
  input: UpdateCalendarInput,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE calendars SET
           name = ?, event_duration_minutes = ?, refresh_minutes = ?,
           window_past_days = ?, window_future_days = ?, statuses = ?,
           show_channel_in_title = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.name,
        input.eventDurationMinutes,
        input.refreshMinutes,
        input.windowPastDays,
        input.windowFutureDays,
        serializeStatuses(input.statuses),
        input.showChannelInTitle ? 1 : 0,
        now(),
        calendarId,
      ),
    db.prepare('DELETE FROM calendar_channels WHERE calendar_id = ?').bind(calendarId),
    ...input.channels.map((channel) =>
      db
        .prepare(
          `INSERT INTO calendar_channels (calendar_id, channel_id, channel_name, service)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(calendarId, channel.id, channel.name, channel.service),
    ),
  ]);
}

/** Invalidates the old feed URL by issuing a new token. */
export async function rotateFeedToken(db: D1Database, calendarId: string): Promise<string> {
  const token = randomToken(32);
  await db
    .prepare('UPDATE calendars SET feed_token = ?, updated_at = ? WHERE id = ?')
    .bind(token, now(), calendarId)
    .run();
  return token;
}

export async function deleteCalendar(db: D1Database, calendarId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM calendar_channels WHERE calendar_id = ?').bind(calendarId),
    db.prepare('DELETE FROM calendars WHERE id = ?').bind(calendarId),
  ]);
}

/** Records that a client polled the feed, whether or not Buffer was hit. */
export async function recordPoll(
  db: D1Database,
  calendarId: string,
  outcome: { fetched: boolean; eventCount?: number; error?: string | null },
): Promise<void> {
  const timestamp = now();

  if (!outcome.fetched) {
    await db
      .prepare('UPDATE calendars SET last_polled_at = ? WHERE id = ?')
      .bind(timestamp, calendarId)
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE calendars SET
         last_polled_at = ?, last_fetched_at = ?, last_event_count = ?, last_error = ?
       WHERE id = ?`,
    )
    .bind(timestamp, timestamp, outcome.eventCount ?? null, outcome.error ?? null, calendarId)
    .run();
}

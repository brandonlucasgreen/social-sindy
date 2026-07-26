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
}

export interface CalendarChannelRow {
  calendar_id: string;
  channel_id: string;
  channel_name: string;
  service: string;
}

export interface CalendarWithChannels extends CalendarRow {
  channels: CalendarChannelRow[];
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
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
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
    .prepare('SELECT * FROM calendars WHERE user_id = ? ORDER BY created_at DESC')
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
    .prepare('SELECT * FROM calendars WHERE id = ? AND user_id = ?')
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
    .prepare('SELECT * FROM calendars WHERE feed_token = ?')
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

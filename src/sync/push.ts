/**
 * Pushes a calendar's posts into a dedicated Google calendar.
 *
 * This is the only mechanism that makes Google fast: a subscribed ICS feed is
 * re-fetched on Google's own 8–24 hour schedule, whereas events written through
 * the API appear immediately.
 */

import {
  GoogleApiError,
  GoogleCalendarClient,
  type ExistingEvent,
} from '../google/calendar.js';
import {
  GoogleAuthError,
  refreshAccessToken,
  type GoogleOAuthConfig,
} from '../google/oauth.js';
import { openSecret } from '../crypto.js';
import {
  clearGoogleCalendar,
  getGoogleCredential,
  recordPush,
  setGoogleCalendarId,
  type CalendarWithChannels,
} from '../db.js';
import type { Env } from '../env.js';
import type { ChannelRef } from '../present.js';
import { googleConfig } from './google-config.js';
import { postsForCalendar, windowFor } from './posts.js';
import { isPlanEmpty, planSync, type SyncPlan } from './reconcile.js';

export interface PushStats {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

/**
 * Ceiling on writes per run. A calendar whose whole window changed at once
 * should not turn into thousands of Google calls in a single cron tick; the
 * remainder is picked up on the next pass.
 */
const MAX_WRITES_PER_RUN = 250;

/** Google's per-user rate limits punish bursts, so writes go out in small waves. */
const WRITE_CONCURRENCY = 4;

function channelRefs(calendar: CalendarWithChannels): Map<string, ChannelRef> {
  return new Map(
    calendar.channels.map((row) => [
      row.channel_id,
      { id: row.channel_id, name: row.channel_name, service: row.service },
    ]),
  );
}

/**
 * Returns a usable Google access token, refreshing when the cached one expired.
 *
 * Cached in KV rather than the database because it is short-lived; only the
 * refresh token is persisted, encrypted.
 */
export async function googleAccessToken(
  env: Env,
  userId: string,
  config: GoogleOAuthConfig,
): Promise<string> {
  const cacheKey = `gtoken:${userId}`;
  const cached = await env.FEED_CACHE.get(cacheKey);
  if (cached) return cached;

  const credential = await getGoogleCredential(env.DB, userId);
  if (!credential) throw new GoogleAuthError('Google is not connected', true);

  const refreshToken = await openSecret(
    { ciphertext: credential.ciphertext, iv: credential.iv },
    env.ENCRYPTION_KEY,
  );

  const tokens = await refreshAccessToken(config, refreshToken);

  // Expire a minute early so a token never dies mid-run.
  await env.FEED_CACHE.put(cacheKey, tokens.accessToken, {
    expirationTtl: Math.max(60, tokens.expiresInSeconds - 60),
  });

  return tokens.accessToken;
}

async function runWrites(
  plan: SyncPlan,
  calendarId: string,
  client: GoogleCalendarClient,
): Promise<PushStats> {
  const stats: PushStats = { created: 0, updated: 0, deleted: 0, unchanged: plan.unchanged };

  const jobs: (() => Promise<void>)[] = [
    ...plan.create.map((event) => async () => {
      await client.upsertEvent(calendarId, event);
      stats.created++;
    }),
    ...plan.update.map((event) => async () => {
      await client.patchEvent(calendarId, event);
      stats.updated++;
    }),
    ...plan.remove.map((eventId) => async () => {
      await client.deleteEvent(calendarId, eventId);
      stats.deleted++;
    }),
  ].slice(0, MAX_WRITES_PER_RUN);

  for (let i = 0; i < jobs.length; i += WRITE_CONCURRENCY) {
    await Promise.all(jobs.slice(i, i + WRITE_CONCURRENCY).map((job) => job()));
  }

  return stats;
}

export interface PushOutcome {
  stats: PushStats;
  /** True when nothing needed changing. */
  noop: boolean;
}

/**
 * Ensures the dedicated Google calendar exists, then reconciles it.
 *
 * Errors are recorded against the calendar and rethrown, so the scheduler can
 * carry on with other calendars while the UI still shows what went wrong.
 */
export async function pushCalendar(
  env: Env,
  calendar: CalendarWithChannels,
  now: Date = new Date(),
): Promise<PushOutcome> {
  const config = googleConfig(env);
  if (!config) throw new GoogleAuthError('Google push is not configured on this deployment');

  try {
    const accessToken = await googleAccessToken(env, calendar.user_id, config);
    const client = new GoogleCalendarClient(accessToken);

    let googleCalendarId = calendar.google_calendar_id;
    if (!googleCalendarId) {
      googleCalendarId = await client.createCalendar(calendar.name, calendar.user_timezone ?? 'UTC');
      await setGoogleCalendarId(env.DB, calendar.id, googleCalendarId);
    }

    const { bundle } = await postsForCalendar(env, calendar, now);
    const { start, end } = windowFor(calendar, now);

    let existing: ExistingEvent[];
    try {
      existing = await client.listOwnEvents(googleCalendarId, start, end);
    } catch (error) {
      // The user may have deleted the calendar in Google. Forget it and let the
      // next run recreate it, rather than failing forever.
      if (error instanceof GoogleApiError && (error.isNotFound || error.status === 410)) {
        await clearGoogleCalendar(env.DB, calendar.id);
        throw new GoogleApiError(
          'That Google calendar no longer exists. It will be recreated on the next sync.',
          error.status,
        );
      }
      throw error;
    }

    const plan = planSync(bundle.posts, existing, channelRefs(calendar), {
      eventDurationMinutes: calendar.event_duration_minutes,
      showChannelInTitle: calendar.show_channel_in_title === 1,
      timeZone: calendar.user_timezone ?? 'UTC',
    });

    if (isPlanEmpty(plan)) {
      await recordPush(env.DB, calendar.id, {
        stats: { created: 0, updated: 0, deleted: 0, unchanged: plan.unchanged },
        error: null,
      });
      return { stats: { created: 0, updated: 0, deleted: 0, unchanged: plan.unchanged }, noop: true };
    }

    const stats = await runWrites(plan, googleCalendarId, client);
    await recordPush(env.DB, calendar.id, { stats, error: null });

    return { stats, noop: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await recordPush(env.DB, calendar.id, { stats: null, error: message });
    throw error;
  }
}

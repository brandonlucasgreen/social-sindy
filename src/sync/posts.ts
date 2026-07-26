/**
 * The single place Buffer posts are fetched for a calendar.
 *
 * Both outputs — the ICS feed and the Google Calendar push — read through this
 * cache, so a user running both does not spend their Buffer quota twice per
 * interval. Buffer's 24-hour budget can be as low as 250 requests, so that
 * doubling would be material.
 */

import { BufferAuthError, BufferClient, lowestRemaining } from '../buffer/client.js';
import type { BufferPost } from '../buffer/types.js';
import { openSecret } from '../crypto.js';
import { getCredential, parseStatuses, type CalendarWithChannels } from '../db.js';
import type { Env } from '../env.js';

/** KV requires at least 60s for expirationTtl. */
const MIN_TTL_SECONDS = 60;

export interface PostBundle {
  posts: BufferPost[];
  /** True when the page cap stopped us before the queue was exhausted. */
  truncated: boolean;
  fetchedAt: string;
}

export interface PostsResult {
  bundle: PostBundle;
  /** True when served from cache without contacting Buffer. */
  cached: boolean;
}

/**
 * Keyed on `updated_at` so editing the channel selection, status filter, or
 * window takes effect immediately rather than after the interval elapses.
 */
function cacheKey(calendar: CalendarWithChannels): string {
  return `posts:${calendar.id}:${calendar.updated_at}`;
}

export function windowFor(calendar: CalendarWithChannels, now: Date): { start: Date; end: Date } {
  return {
    start: new Date(now.getTime() - calendar.window_past_days * 86_400_000),
    end: new Date(now.getTime() + calendar.window_future_days * 86_400_000),
  };
}

export async function postsForCalendar(
  env: Env,
  calendar: CalendarWithChannels,
  now: Date = new Date(),
): Promise<PostsResult> {
  const key = cacheKey(calendar);
  const hit = await env.FEED_CACHE.get(key, 'json');
  if (hit) return { bundle: hit as PostBundle, cached: true };

  const credential = await getCredential(env.DB, calendar.user_id);
  if (!credential) throw new BufferAuthError('No Buffer API key is stored for this calendar');

  const apiKey = await openSecret(
    { ciphertext: credential.ciphertext, iv: credential.iv },
    env.ENCRYPTION_KEY,
  );

  const { start, end } = windowFor(calendar, now);
  const { posts, rateLimit, truncated } = await new BufferClient(apiKey).fetchPosts({
    organizationId: calendar.organization_id,
    channelIds: calendar.channels.map((channel) => channel.channel_id),
    statuses: parseStatuses(calendar.statuses),
    start,
    end,
  });

  const remaining = lowestRemaining(rateLimit);
  if (remaining !== null && remaining < 10) {
    console.warn(`calendar=${calendar.id} buffer quota nearly exhausted, remaining=${remaining}`);
  }
  if (truncated) {
    console.warn(`calendar=${calendar.id} hit the page cap; output may omit the tail of the queue`);
  }

  const bundle: PostBundle = { posts, truncated, fetchedAt: now.toISOString() };
  await env.FEED_CACHE.put(key, JSON.stringify(bundle), {
    expirationTtl: Math.max(MIN_TTL_SECONDS, calendar.refresh_minutes * 60),
  });

  return { bundle, cached: false };
}

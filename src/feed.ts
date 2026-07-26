/**
 * The public iCalendar feed.
 *
 * Unauthenticated by necessity: Google, Apple, and Outlook fetch subscribed
 * feeds without the ability to send a credential, so the feed token in the URL
 * is the only secret. Two consequences shape this module:
 *
 *  1. Anyone holding the URL can read the feed, so tokens are 32 random bytes
 *     and can be rotated.
 *  2. The endpoint is a public trigger for a Buffer API call, and Buffer's
 *     quota is small. Every response is served from KV within the calendar's
 *     refresh interval, so no volume of polling can drain a user's quota: at
 *     most one Buffer fetch per interval, however often the URL is hit.
 */

import {
  BufferAuthError,
  BufferClient,
  BufferRateLimitError,
  lowestRemaining,
} from './buffer/client.js';
import { openSecret } from './crypto.js';
import { getCredential, parseStatuses, recordPoll, type CalendarWithChannels } from './db.js';
import type { Env } from './env.js';
import { generateIcs, type ChannelRef } from './ics/generate.js';

/** How long a successful render is kept as the fallback for a failed refresh. */
const LAST_GOOD_TTL_SECONDS = 7 * 86_400;

/** KV requires at least 60s for expirationTtl. */
const MIN_KV_TTL_SECONDS = 60;

export interface FeedResult {
  body: string;
  /** True when served from cache without contacting Buffer. */
  cached: boolean;
  /** True when Buffer could not be reached and a previous render was served. */
  stale: boolean;
  eventCount: number | null;
}

function freshKey(calendar: CalendarWithChannels): string {
  // The updated_at stamp is part of the key so a settings change invalidates
  // the cached render immediately rather than waiting out the TTL.
  return `feed:fresh:${calendar.id}:${calendar.updated_at}`;
}

function lastGoodKey(calendar: CalendarWithChannels): string {
  return `feed:last-good:${calendar.id}`;
}

function channelRefs(calendar: CalendarWithChannels): Map<string, ChannelRef> {
  return new Map(
    calendar.channels.map((row) => [
      row.channel_id,
      { id: row.channel_id, name: row.channel_name, service: row.service },
    ]),
  );
}

/** Renders the feed, preferring cache and falling back to the last good copy. */
export function buildFeed(
  env: Env,
  calendar: CalendarWithChannels,
  now: Date = new Date(),
): Promise<FeedResult> {
  return cachedFeed(env, calendar, () => renderFromBuffer(env, calendar, now));
}

/**
 * The caching and failure policy around a render, independent of where the
 * content comes from.
 *
 * Two properties matter enough to be tested directly: a cache hit must never
 * reach Buffer (that is what protects the quota from unbounded polling), and a
 * Buffer failure must never surface as an empty calendar, which clients would
 * interpret as every event having been deleted.
 */
export async function cachedFeed(
  env: Env,
  calendar: CalendarWithChannels,
  render: () => Promise<string>,
): Promise<FeedResult> {
  const cached = await env.FEED_CACHE.get(freshKey(calendar));
  if (cached) return { body: cached, cached: true, stale: false, eventCount: null };

  try {
    const body = await render();
    const ttl = Math.max(MIN_KV_TTL_SECONDS, calendar.refresh_minutes * 60);

    await Promise.all([
      env.FEED_CACHE.put(freshKey(calendar), body, { expirationTtl: ttl }),
      env.FEED_CACHE.put(lastGoodKey(calendar), body, { expirationTtl: LAST_GOOD_TTL_SECONDS }),
    ]);

    const eventCount = (body.match(/BEGIN:VEVENT/g) ?? []).length;
    return { body, cached: false, stale: false, eventCount };
  } catch (error) {
    // A transient Buffer failure must not make a subscribed calendar go empty,
    // which clients would render as every event being deleted.
    const lastGood = await env.FEED_CACHE.get(lastGoodKey(calendar));
    if (lastGood) {
      // Back off before retrying, so a rate-limited account is not hammered.
      const backoff =
        error instanceof BufferRateLimitError && error.retryAfterSeconds
          ? Math.max(MIN_KV_TTL_SECONDS, error.retryAfterSeconds)
          : MIN_KV_TTL_SECONDS * 5;
      await env.FEED_CACHE.put(freshKey(calendar), lastGood, { expirationTtl: backoff });

      return { body: lastGood, cached: true, stale: true, eventCount: null };
    }
    throw error;
  }
}

async function renderFromBuffer(
  env: Env,
  calendar: CalendarWithChannels,
  now: Date,
): Promise<string> {
  const credential = await getCredential(env.DB, calendar.user_id);
  if (!credential) throw new BufferAuthError('No Buffer API key is stored for this calendar');

  const apiKey = await openSecret(
    { ciphertext: credential.ciphertext, iv: credential.iv },
    env.ENCRYPTION_KEY,
  );

  const client = new BufferClient(apiKey);
  const start = new Date(now.getTime() - calendar.window_past_days * 86_400_000);
  const end = new Date(now.getTime() + calendar.window_future_days * 86_400_000);

  const { posts, rateLimit, truncated } = await client.fetchPosts({
    organizationId: calendar.organization_id,
    channelIds: calendar.channels.map((c) => c.channel_id),
    statuses: parseStatuses(calendar.statuses),
    start,
    end,
  });

  const remaining = lowestRemaining(rateLimit);
  if (remaining !== null && remaining < 10) {
    console.warn(
      `calendar=${calendar.id} buffer quota nearly exhausted, remaining=${remaining}`,
    );
  }
  if (truncated) {
    console.warn(`calendar=${calendar.id} hit the page cap; feed may omit the tail of the queue`);
  }

  const description = truncated
    ? `${calendar.organization_name} — showing the first pages of a large queue`
    : calendar.organization_name;

  return generateIcs(
    posts,
    channelRefs(calendar),
    {
      calendarId: calendar.id,
      name: calendar.name,
      description,
      timezone: 'UTC',
      eventDurationMinutes: calendar.event_duration_minutes,
      refreshMinutes: calendar.refresh_minutes,
      showChannelInTitle: calendar.show_channel_in_title === 1,
    },
    now,
  );
}

/** Weak validator over the rendered body, so unchanged feeds can 304. */
export async function etagFor(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body) as BufferSource);
  const hex = [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `W/"${hex}"`;
}

export interface FeedResponseOptions {
  /** Records the poll without adding latency to the response. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export async function respondWithFeed(
  env: Env,
  calendar: CalendarWithChannels,
  request: Request,
  options: FeedResponseOptions = {},
): Promise<Response> {
  let result: FeedResult;
  try {
    result = await buildFeed(env, calendar);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    options.waitUntil?.(recordPoll(env.DB, calendar.id, { fetched: true, error: message }));

    // 401 would tell a calendar client to prompt for credentials it cannot
    // supply; 503 with Retry-After is the signal to try again later.
    const retryAfter = error instanceof BufferRateLimitError ? error.retryAfterSeconds : null;
    return new Response(`Could not build this feed: ${message}\n`, {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': String(retryAfter ?? 900),
      },
    });
  }

  options.waitUntil?.(
    recordPoll(env.DB, calendar.id, {
      fetched: !result.cached,
      eventCount: result.eventCount ?? undefined,
      error: null,
    }),
  );

  const etag = await etagFor(result.body);
  const headers: Record<string, string> = {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `inline; filename="${calendar.id}.ics"`,
    'Cache-Control': `public, max-age=${Math.max(60, calendar.refresh_minutes * 60)}`,
    ETag: etag,
    // The feed is a private URL; keep it out of search engines and referrers.
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  };
  if (result.stale) headers['X-Feed-Stale'] = 'true';

  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(request.method === 'HEAD' ? null : result.body, { status: 200, headers });
}

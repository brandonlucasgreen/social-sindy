/**
 * The public feed endpoint — handles both ICS and Atom outputs.
 *
 * Unauthenticated by necessity: Google, Apple, Outlook, and RSS readers fetch
 * subscribed feeds without the ability to send a credential, so the feed token
 * in the URL is the only secret. Two consequences shape this module:
 *
 *  1. Anyone holding the URL can read the feed, so tokens are 32 random bytes
 *     and can be rotated.
 *  2. The endpoint is a public trigger for a Buffer API call, and Buffer's
 *     quota is small. Every response is served from KV within the output's
 *     refresh interval, so no volume of polling can drain a user's quota: at
 *     most one Buffer fetch per interval, however often the URL is hit.
 */

import { BufferRateLimitError } from './buffer/client.js';
import { recordPoll, type OutputWithChannels } from './db.js';
import type { Env } from './env.js';
import { generateIcs, type ChannelRef } from './ics/generate.js';
import { generateAtom } from './atom/generate.js';
import { postsForOutput } from './sync/posts.js';

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

function freshKey(output: OutputWithChannels): string {
  // The updated_at stamp is part of the key so a settings change invalidates
  // the cached render immediately rather than waiting out the TTL.
  return `feed:fresh:${output.id}:${output.updated_at}`;
}

function lastGoodKey(output: OutputWithChannels): string {
  return `feed:last-good:${output.id}`;
}

function channelRefs(output: OutputWithChannels): Map<string, ChannelRef> {
  return new Map(
    output.channels.map((row) => [
      row.channel_id,
      { id: row.channel_id, name: row.channel_name, service: row.service },
    ]),
  );
}

/** Renders the feed, preferring cache and falling back to the last good copy. */
export function buildFeed(
  env: Env,
  output: OutputWithChannels,
  now: Date = new Date(),
): Promise<FeedResult> {
  return cachedFeed(env, output, () => renderFromBuffer(env, output, now));
}

/**
 * The caching and failure policy around a render, independent of where the
 * content comes from.
 *
 * Two properties matter enough to be tested directly: a cache hit must never
 * reach Buffer (that is what protects the quota from unbounded polling), and a
 * Buffer failure must never surface as an empty feed, which clients would
 * interpret as every event having been deleted.
 */
export async function cachedFeed(
  env: Env,
  output: OutputWithChannels,
  render: () => Promise<string>,
): Promise<FeedResult> {
  const cached = await env.FEED_CACHE.get(freshKey(output));
  if (cached) return { body: cached, cached: true, stale: false, eventCount: null };

  try {
    const body = await render();
    const ttl = Math.max(MIN_KV_TTL_SECONDS, output.refresh_minutes * 60);

    await Promise.all([
      env.FEED_CACHE.put(freshKey(output), body, { expirationTtl: ttl }),
      env.FEED_CACHE.put(lastGoodKey(output), body, { expirationTtl: LAST_GOOD_TTL_SECONDS }),
    ]);

    // Count events/items depending on format
    const eventCount =
      output.format === 'ics'
        ? (body.match(/BEGIN:VEVENT/g) ?? []).length
        : (body.match(/<entry>/g) ?? []).length;

    return { body, cached: false, stale: false, eventCount };
  } catch (error) {
    // A transient Buffer failure must not make a subscribed feed go empty,
    // which clients would render as every event having been deleted.
    const lastGood = await env.FEED_CACHE.get(lastGoodKey(output));
    if (lastGood) {
      // Back off before retrying, so a rate-limited account is not hammered.
      const backoff =
        error instanceof BufferRateLimitError && error.retryAfterSeconds
          ? Math.max(MIN_KV_TTL_SECONDS, error.retryAfterSeconds)
          : MIN_KV_TTL_SECONDS * 5;
      await env.FEED_CACHE.put(freshKey(output), lastGood, { expirationTtl: backoff });

      return { body: lastGood, cached: true, stale: true, eventCount: null };
    }
    throw error;
  }
}

async function renderIcs(
  env: Env,
  output: OutputWithChannels,
  now: Date,
): Promise<string> {
  const { bundle } = await postsForOutput(env, output, now);
  const { posts, truncated } = bundle;

  const description = truncated
    ? `${output.organization_name} — showing the first pages of a large queue`
    : output.organization_name;

  return generateIcs(
    posts,
    channelRefs(output),
    {
      calendarId: output.id,
      name: output.name,
      description,
      timezone: 'UTC',
      eventDurationMinutes: output.event_duration_minutes,
      refreshMinutes: output.refresh_minutes,
      showChannelInTitle: output.show_channel_in_title === 1,
    },
    now,
  );
}

async function renderAtom(
  env: Env,
  output: OutputWithChannels,
  now: Date,
): Promise<string> {
  const { bundle } = await postsForOutput(env, output, now);
  const { posts, truncated } = bundle;

  const description = truncated
    ? `${output.organization_name} — showing the most recent posts from a large history`
    : output.organization_name;

  return generateAtom(posts, channelRefs(output), {
    feedId: output.id,
    name: output.name,
    subtitle: description,
    appUrl: env.APP_BASE_URL,
    feedToken: output.feed_token,
    groupCrossPosts: output.group_cross_posts === 1,
  }, now);
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
  output: OutputWithChannels,
  request: Request,
  options: FeedResponseOptions = {},
): Promise<Response> {
  let result: FeedResult;
  try {
    result = await buildFeed(env, output);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    options.waitUntil?.(recordPoll(env.DB, output.id, { fetched: true, error: message }));

    // 401 would tell a client to prompt for credentials it cannot
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
    recordPoll(env.DB, output.id, {
      fetched: !result.cached,
      eventCount: result.eventCount ?? undefined,
      error: null,
    }),
  );

  const isIcs = output.format === 'ics';
  const etag = await etagFor(result.body);
  const headers: Record<string, string> = {
    'Content-Type': isIcs ? 'text/calendar; charset=utf-8' : 'application/atom+xml; charset=utf-8',
    'Cache-Control': `public, max-age=${Math.max(60, output.refresh_minutes * 60)}`,
    ETag: etag,
    // The feed is a private URL; keep it out of search engines and referrers.
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  };

  if (isIcs) {
    headers['Content-Disposition'] = `inline; filename="${output.id}.ics"`;
  }

  if (result.stale) headers['X-Feed-Stale'] = 'true';

  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(request.method === 'HEAD' ? null : result.body, { status: 200, headers });
}
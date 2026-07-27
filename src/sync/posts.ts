/**
 * The single place Buffer posts are fetched for an output.
 *
 * Both outputs — the ICS feed and the Google Calendar push — read through this
 * cache, so a user running both does not spend their Buffer quota twice per
 * interval. Buffer's 24-hour budget can be as low as 250 requests, so that
 * doubling would be material.
 */

import { BufferClient, lowestRemaining } from '../buffer/client.js';
import { bufferTokenFor } from '../buffer/token.js';
import type { BufferPost } from '../buffer/types.js';
import { parseStatuses, type OutputWithChannels } from '../db.js';
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
function cacheKey(output: OutputWithChannels): string {
  return `posts:${output.id}:${output.updated_at}`;
}

export function windowFor(output: OutputWithChannels, now: Date): { start: Date; end: Date } {
  return {
    start: new Date(now.getTime() - output.window_past_days * 86_400_000),
    end: new Date(now.getTime() + output.window_future_days * 86_400_000),
  };
}

export async function postsForOutput(
  env: Env,
  output: OutputWithChannels,
  now: Date = new Date(),
): Promise<PostsResult> {
  const key = cacheKey(output);
  const hit = await env.FEED_CACHE.get(key, 'json');
  if (hit) return { bundle: hit as PostBundle, cached: true };

  // Resolves an OAuth access token or a stored API key, whichever this user
  // connected with. On the cron path this is also where a rotated refresh token
  // gets persisted, so it must run before the fetch, not alongside it.
  const token = await bufferTokenFor(env, output.user_id);

  const { start, end } = windowFor(output, now);
  const { posts, rateLimit, truncated } = await new BufferClient(token).fetchPosts({
    organizationId: output.organization_id,
    channelIds: output.channels.map((channel) => channel.channel_id),
    statuses: parseStatuses(output.statuses),
    start,
    end,
  });

  // Apply max_items cap for Atom outputs
  let finalPosts = posts;
  let finalTruncated = truncated;
  if (output.format === 'atom' && output.max_items > 0 && finalPosts.length > output.max_items) {
    finalPosts = finalPosts.slice(0, output.max_items);
    finalTruncated = true;
  }

  const remaining = lowestRemaining(rateLimit);
  if (remaining !== null && remaining < 10) {
    console.warn(`output=${output.id} buffer quota nearly exhausted, remaining=${remaining}`);
  }
  if (finalTruncated) {
    console.warn(`output=${output.id} hit the page cap; output may omit the tail of the queue`);
  }

  const bundle: PostBundle = { posts: finalPosts, truncated: finalTruncated, fetchedAt: now.toISOString() };
  await env.FEED_CACHE.put(key, JSON.stringify(bundle), {
    expirationTtl: Math.max(MIN_TTL_SECONDS, output.refresh_minutes * 60),
  });

  return { bundle, cached: false };
}
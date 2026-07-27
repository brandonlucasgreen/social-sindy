/**
 * Diffs Buffer posts against the events already in a Google calendar.
 *
 * Pure and synchronous — no I/O — so the rules that decide what gets deleted
 * from someone's calendar are testable in isolation.
 *
 * There is deliberately no local mapping table. Each event's identity is derived
 * from its Buffer post ID, and Buffer's `updatedAt` is stored on the event
 * itself, so Google holds all the sync state. Nothing can fall out of step with
 * a database row.
 */

import type { BufferPost } from '../buffer/types.js';
import {
  bufferPostUrl,
  eventDescription,
  eventTitle,
  isTentative,
  postEnd,
  postInstant,
  resolveChannel,
  type ChannelRef,
  type PresentOptions,
} from '../present.js';
import {
  OWNER_TAG_KEY,
  OWNER_TAG_VALUE,
  POST_ID_KEY,
  UPDATED_AT_KEY,
  type ExistingEvent,
  type GoogleEvent,
} from '../google/calendar.js';

/**
 * Derives a Google event ID from a Buffer post ID.
 *
 * Google requires base32hex characters (lowercase a–v and 0–9), 5–1024 long.
 * Buffer post IDs are already lowercase hex, but rather than branch on that,
 * every ID is hex-encoded unconditionally. That is injective, so two different
 * posts can never collide — whereas "use the raw ID when it happens to be
 * valid, otherwise encode" could map a raw ID of `616263` and an encoded `abc`
 * onto the same event.
 */
export function googleEventId(postId: string): string {
  let hex = '';
  for (const byte of new TextEncoder().encode(postId)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  // The `bc` prefix keeps IDs recognisable in Google's UI and guarantees the
  // 5-character minimum even for an implausibly short post ID.
  return `bc${hex}`.slice(0, 1024);
}

export interface SyncPlan {
  create: GoogleEvent[];
  update: GoogleEvent[];
  /** Google event IDs to remove. */
  remove: string[];
  /** Events already in sync, counted for reporting. */
  unchanged: number;
}

export function isPlanEmpty(plan: SyncPlan): boolean {
  return plan.create.length === 0 && plan.update.length === 0 && plan.remove.length === 0;
}

export interface ReconcileOptions extends PresentOptions {
  /** IANA zone recorded on each event; instants themselves are absolute. */
  timeZone: string;
}

/** Builds the Google event body for a post. */
export function toGoogleEvent(
  post: BufferPost,
  channels: Map<string, ChannelRef>,
  options: ReconcileOptions,
): GoogleEvent | null {
  const start = postInstant(post);
  if (!start) return null;

  const channel = resolveChannel(post, channels);

  return {
    id: googleEventId(post.id),
    summary: eventTitle(post, channel, options),
    description: eventDescription(post, channel),
    start: { dateTime: start.toISOString(), timeZone: options.timeZone },
    end: { dateTime: postEnd(start, options.eventDurationMinutes ?? 15).toISOString(), timeZone: options.timeZone },
    status: isTentative(post) ? 'tentative' : 'confirmed',
    // Informational, not time the user is busy.
    transparency: 'transparent',
    source: { title: 'Open in Buffer', url: bufferPostUrl(post.id) },
    extendedProperties: {
      private: {
        // Marks the event as ours. Reconciliation only ever sees events carrying
        // this tag, so an event the user added themselves is never deleted.
        [OWNER_TAG_KEY]: OWNER_TAG_VALUE,
        [POST_ID_KEY]: post.id,
        // Lets the next pass detect a real edit without any local bookkeeping.
        [UPDATED_AT_KEY]: post.updatedAt,
      },
    },
  };
}

export function planSync(
  posts: BufferPost[],
  existing: ExistingEvent[],
  channels: Map<string, ChannelRef>,
  options: ReconcileOptions,
): SyncPlan {
  const plan: SyncPlan = { create: [], update: [], remove: [], unchanged: 0 };

  const existingById = new Map(existing.map((event) => [event.id, event]));
  const wanted = new Set<string>();

  for (const post of posts) {
    const event = toGoogleEvent(post, channels, options);
    if (!event) continue; // No date: nothing to place on a calendar.

    // A duplicate post ID in one response must not produce two writes for the
    // same event, which would race against each other.
    if (wanted.has(event.id)) continue;
    wanted.add(event.id);

    const current = existingById.get(event.id);
    if (!current) {
      plan.create.push(event);
    } else if (current.updatedMarker !== post.updatedAt) {
      plan.update.push(event);
    } else {
      plan.unchanged++;
    }
  }

  // Anything of ours still in the window that Buffer no longer lists has been
  // unscheduled, deleted, or moved out of range.
  for (const event of existing) {
    if (!wanted.has(event.id)) plan.remove.push(event.id);
  }

  return plan;
}

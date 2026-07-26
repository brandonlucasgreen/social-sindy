/**
 * Renders Buffer posts as a subscribable iCalendar document.
 *
 * Pure: takes posts and options in, returns the feed body. No I/O, so the
 * mapping rules are testable in isolation. How a post becomes an event lives in
 * `src/present.ts`, shared with the Google Calendar push.
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
  serviceLabel,
  type ChannelRef,
} from '../present.js';
import { escapeText, formatDuration, formatUtc, LineWriter } from './serialize.js';

export type { ChannelRef };

const PRODID = '-//buffer-cally//Buffer Publishing Schedule//EN';

export interface FeedOptions {
  /** Namespaces event UIDs so two feeds never collide in one calendar client. */
  calendarId: string;
  name: string;
  description?: string;
  /** Display hint for clients; events themselves are always emitted in UTC. */
  timezone: string;
  eventDurationMinutes: number;
  /** Advertised to clients as the polling interval they should honour. */
  refreshMinutes: number;
  showChannelInTitle: boolean;
}

export function generateIcs(
  posts: BufferPost[],
  channels: Map<string, ChannelRef>,
  options: FeedOptions,
  now: Date = new Date(),
): string {
  const writer = new LineWriter();
  const stamp = formatUtc(now);

  writer.add('BEGIN', 'VCALENDAR');
  writer.add('VERSION', '2.0');
  writer.add('PRODID', PRODID);
  writer.add('CALSCALE', 'GREGORIAN');
  writer.add('X-WR-CALNAME', escapeText(options.name));
  if (options.description) writer.add('X-WR-CALDESC', escapeText(options.description));
  writer.add('X-WR-TIMEZONE', escapeText(options.timezone));

  // Both spellings of the polling hint: X-PUBLISHED-TTL is the widely honoured
  // legacy property, REFRESH-INTERVAL is the RFC 7986 standard one. Apple
  // Calendar respects these; Google ignores them and polls on its own schedule.
  const ttl = formatDuration(options.refreshMinutes);
  writer.add('X-PUBLISHED-TTL', ttl);
  writer.addRaw(`REFRESH-INTERVAL;VALUE=DURATION:${ttl}`);

  for (const post of posts) {
    const start = postInstant(post);
    if (!start) continue; // Unscheduled draft: nothing to place on a calendar.

    const channel = resolveChannel(post, channels);

    writer.add('BEGIN', 'VEVENT');
    writer.add('UID', `${post.id}.${options.calendarId}@buffer-cally`);
    writer.add('DTSTAMP', stamp);

    // Buffer's own updatedAt, so a client can distinguish a genuine edit from
    // the feed simply being re-generated on the next poll.
    const modified = new Date(post.updatedAt);
    if (!Number.isNaN(modified.getTime())) writer.add('LAST-MODIFIED', formatUtc(modified));

    writer.add('DTSTART', formatUtc(start));
    writer.add('DTEND', formatUtc(postEnd(start, options)));
    writer.add('SUMMARY', escapeText(eventTitle(post, channel, options)));
    writer.add('DESCRIPTION', escapeText(eventDescription(post, channel)));
    writer.add('URL', bufferPostUrl(post.id));
    writer.add('STATUS', isTentative(post) ? 'TENTATIVE' : 'CONFIRMED');

    const categories = [
      serviceLabel(channel?.service ?? post.channelService),
      ...post.tags.map((t) => t.name),
    ];
    writer.add('CATEGORIES', categories.map(escapeText).join(','));

    // Events are informational rather than time you are busy.
    writer.add('TRANSP', 'TRANSPARENT');

    const image = post.assets.find((a) => a.source);
    if (image?.source) {
      const fmt = image.mimeType ? `;FMTTYPE=${image.mimeType}` : '';
      writer.addRaw(`ATTACH${fmt}:${image.source}`);
    }

    writer.add('END', 'VEVENT');
  }

  writer.add('END', 'VCALENDAR');
  return writer.toString();
}

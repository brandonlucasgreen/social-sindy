/**
 * Renders Buffer posts as a subscribable iCalendar document.
 *
 * Pure: takes posts and options in, returns the feed body. No I/O, so the
 * mapping rules are testable in isolation.
 */

import type { BufferPost } from '../buffer/types.js';
import { escapeText, formatDuration, formatUtc, LineWriter } from './serialize.js';

const PRODID = '-//buffer-gcal//Buffer Publishing Schedule//EN';

/**
 * Deep link to a single post in Buffer's web app.
 *
 * Buffer does not document a canonical permalink for a post, so this is a
 * best-effort link surfaced as the event URL.
 */
export function bufferPostUrl(postId: string): string {
  return `https://publish.buffer.com/post/${postId}`;
}

export interface ChannelRef {
  id: string;
  name: string;
  service: string;
}

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

const SERVICE_EMOJI: Record<string, string> = {
  bluesky: '🦋',
  facebook: '📘',
  instagram: '📸',
  linkedin: '💼',
  mastodon: '🐘',
  pinterest: '📌',
  reddit: '👽',
  threads: '🧵',
  tiktok: '🎵',
  twitter: '🐦',
  x: '🐦',
  youtube: '▶️',
  googlebusiness: '🏪',
  startPage: '🔗',
};

const SERVICE_LABEL: Record<string, string> = {
  bluesky: 'Bluesky',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  mastodon: 'Mastodon',
  pinterest: 'Pinterest',
  reddit: 'Reddit',
  threads: 'Threads',
  tiktok: 'TikTok',
  twitter: 'X',
  x: 'X',
  youtube: 'YouTube',
  googlebusiness: 'Google Business',
  startPage: 'Start Page',
};

export function serviceLabel(service: string): string {
  return SERVICE_LABEL[service] ?? service.charAt(0).toUpperCase() + service.slice(1);
}

function serviceEmoji(service: string): string {
  return SERVICE_EMOJI[service] ?? '📅';
}

const EXCERPT_LIMIT = 60;

/**
 * Condenses post text into a one-line event title.
 *
 * Splits on code points so a truncation never lands mid-emoji, which is common
 * in social copy.
 */
export function excerpt(text: string | null, limit = EXCERPT_LIMIT): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const chars = Array.from(flat);
  if (chars.length <= limit) return flat;
  return `${chars.slice(0, limit).join('').trimEnd()}…`;
}

/** Buffer statuses that represent a post not yet committed to publishing. */
const TENTATIVE_STATUSES = new Set(['draft', 'needs_approval', 'error']);

/**
 * Resolves the channel to title an event with.
 *
 * The inline channel from the feed query is preferred because it reflects
 * renames immediately; the stored selection is the fallback for posts whose
 * channel could not be resolved.
 */
function resolveChannel(post: BufferPost, channels: Map<string, ChannelRef>): ChannelRef | undefined {
  if (post.channel) {
    return {
      id: post.channel.id,
      name: post.channel.displayName?.trim() || post.channel.name,
      service: post.channel.service,
    };
  }
  return channels.get(post.channelId);
}

function eventTitle(post: BufferPost, channel: ChannelRef | undefined, options: FeedOptions): string {
  const service = channel?.service ?? post.channelService;
  const body = excerpt(post.text) || `${serviceLabel(service)} post`;
  const warning = post.status === 'error' ? '⚠️ ' : '';

  if (!options.showChannelInTitle) return `${warning}${body}`;

  const channelName = channel?.name ?? serviceLabel(service);
  return `${warning}${serviceEmoji(service)} ${channelName}: ${body}`;
}

function eventDescription(post: BufferPost, channel: ChannelRef | undefined): string {
  const service = channel?.service ?? post.channelService;
  const sections: string[] = [];

  if (post.text?.trim()) sections.push(post.text.trim());

  const facts: string[] = [
    `Channel: ${channel?.name ?? '(unknown)'} (${serviceLabel(service)})`,
    `Status: ${post.status}`,
  ];
  if (post.tags.length) facts.push(`Tags: ${post.tags.map((t) => t.name).join(', ')}`);
  if (post.assets.length) {
    const kinds = post.assets.map((a) => a.type ?? 'attachment');
    facts.push(`Media: ${post.assets.length} (${[...new Set(kinds)].join(', ')})`);
  }
  if (post.error) facts.push(`Error: ${post.error.message}`);
  facts.push(`Open in Buffer: ${bufferPostUrl(post.id)}`);

  sections.push(facts.join('\n'));
  return sections.join('\n\n');
}

/** The instant a post occupies on the calendar, or null if it has none. */
function postInstant(post: BufferPost): Date | null {
  const raw = post.dueAt ?? post.sentAt;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
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
    const end = new Date(start.getTime() + options.eventDurationMinutes * 60_000);

    writer.add('BEGIN', 'VEVENT');
    writer.add('UID', `${post.id}.${options.calendarId}@buffer-gcal`);
    writer.add('DTSTAMP', stamp);

    // Buffer's own updatedAt, so a client can distinguish a genuine edit from
    // the feed simply being re-generated on the next poll.
    const modified = new Date(post.updatedAt);
    if (!Number.isNaN(modified.getTime())) writer.add('LAST-MODIFIED', formatUtc(modified));

    writer.add('DTSTART', formatUtc(start));
    writer.add('DTEND', formatUtc(end));
    writer.add('SUMMARY', escapeText(eventTitle(post, channel, options)));
    writer.add('DESCRIPTION', escapeText(eventDescription(post, channel)));
    writer.add('URL', bufferPostUrl(post.id));
    writer.add('STATUS', TENTATIVE_STATUSES.has(post.status) ? 'TENTATIVE' : 'CONFIRMED');

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

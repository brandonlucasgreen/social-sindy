/**
 * How a Buffer post is presented as a calendar event.
 *
 * Shared by the ICS renderer and the Google Calendar push so the two outputs
 * cannot drift apart — a post should look the same however it reaches a
 * calendar.
 */

import type { BufferPost } from './buffer/types.js';

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

/** Presentation options shared across output formats.
 *
 * `eventDurationMinutes` is ICS-only (Atom doesn't have durations); it's
 * optional here so the Atom renderer can call `eventTitle` without
 * supplying a value it doesn't need. The ICS renderer always passes it. */
export interface PresentOptions {
  eventDurationMinutes?: number;
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

/**
 * Buffer's own published per-network brand colours.
 *
 * Used for channel identity in the UI. Several networks are black, and many are
 * near-identical blues, so colour is never the only signal — it always sits
 * beside the network's name.
 */
const SERVICE_COLOR: Record<string, string> = {
  bluesky: 'hsl(211 99% 53%)',
  facebook: 'hsl(214 89% 52%)',
  googlebusiness: 'hsl(220 72% 59%)',
  instagram: 'hsl(331 98% 47%)',
  linkedin: 'hsl(213 63% 43%)',
  mastodon: 'hsl(240 100% 69%)',
  pinterest: 'hsl(351 100% 45%)',
  threads: 'hsl(0 0% 0%)',
  tiktok: 'hsl(0 0% 0%)',
  twitter: 'hsl(0 0% 0%)',
  x: 'hsl(0 0% 0%)',
  youtube: 'hsl(0 100% 50%)',
  startPage: 'hsl(139 37% 32%)',
};

export function serviceColor(service: string): string {
  return SERVICE_COLOR[service] ?? 'hsl(60 3% 54%)';
}

export function serviceLabel(service: string): string {
  return SERVICE_LABEL[service] ?? service.charAt(0).toUpperCase() + service.slice(1);
}

export function serviceEmoji(service: string): string {
  return SERVICE_EMOJI[service] ?? '📅';
}

/**
 * The single character that stands in for a channel with no usable avatar.
 *
 * Skips leading punctuation so an `@handle` or a `#tag` yields its first real
 * letter rather than a sigil every channel would share. `Array.from` rather
 * than indexing, so an emoji or a non-BMP script is taken as one character
 * instead of half a surrogate pair.
 */
export function channelInitial(name: string): string {
  for (const character of Array.from(name.trim())) {
    if (/[\p{L}\p{N}]/u.test(character)) return character.toLocaleUpperCase();
  }
  return '?';
}

/** XML-escape text content. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

export function isTentative(post: BufferPost): boolean {
  return TENTATIVE_STATUSES.has(post.status);
}

/**
 * Resolves the channel to title an event with.
 *
 * The inline channel from the feed query is preferred because it reflects
 * renames immediately; the stored selection is the fallback for posts whose
 * channel could not be resolved.
 */
export function resolveChannel(
  post: BufferPost,
  channels: Map<string, ChannelRef>,
): ChannelRef | undefined {
  if (post.channel) {
    return {
      id: post.channel.id,
      name: post.channel.displayName?.trim() || post.channel.name,
      service: post.channel.service,
    };
  }
  return channels.get(post.channelId);
}

export function eventTitle(
  post: BufferPost,
  channel: ChannelRef | undefined,
  options: PresentOptions,
): string {
  const service = channel?.service ?? post.channelService;
  const body = excerpt(post.text) || `${serviceLabel(service)} post`;
  const warning = post.status === 'error' ? '⚠️ ' : '';

  if (!options.showChannelInTitle) return `${warning}${body}`;

  const channelName = channel?.name ?? serviceLabel(service);
  return `${warning}${serviceEmoji(service)} ${channelName}: ${body}`;
}

export function eventDescription(post: BufferPost, channel: ChannelRef | undefined): string {
  const service = channel?.service ?? post.channelService;
  const sections: string[] = [];

  if (post.text?.trim()) sections.push(post.text.trim());

  const facts: string[] = [
    `Channel: ${channel?.name ?? '(unknown)'} (${serviceLabel(service)})`,
  ];

  // Prefer the publicly available social network URL over the Buffer publish URL
  if (post.externalLink) {
    facts.push(`Post: ${post.externalLink}`);
  } else {
    facts.push(`Open in Buffer: ${bufferPostUrl(post.id)}`);
  }

  if (post.tags.length) facts.push(`Tags: ${post.tags.map((t) => t.name).join(', ')}`);
  if (post.assets.length) {
    const kinds = post.assets.map((a) => a.type ?? 'attachment');
    facts.push(`Media: ${post.assets.length} (${[...new Set(kinds)].join(', ')})`);
  }
  if (post.error) facts.push(`Error: ${post.error.message}`);

  sections.push(facts.join('\n'));
  return sections.join('\n\n');
}

/** HTML variant of eventDescription for Atom feeds.
 *
 * Wrapped in CDATA in the XML, so no XML escaping needed — the HTML
 * tags are literal and will be rendered by the feed reader. */
export function eventDescriptionHtml(post: BufferPost, channel: ChannelRef | undefined): string {
  const service = channel?.service ?? post.channelService;
  const sections: string[] = [];

  if (post.text?.trim()) sections.push(post.text.trim());

  const facts: string[] = [
    `Channel: ${channel?.name ?? '(unknown)'} (${serviceLabel(service)})`,
  ];

  if (post.externalLink) {
    facts.push(`<a href="${post.externalLink}">View on ${serviceLabel(service)}</a>`);
  } else {
    facts.push(`<a href="${bufferPostUrl(post.id)}">Open in Buffer</a>`);
  }

  if (post.tags.length) facts.push(`Tags: ${post.tags.map((t) => t.name).join(', ')}`);
  if (post.assets.length) {
    const kinds = post.assets.map((a) => a.type ?? 'attachment');
    facts.push(`Media: ${post.assets.length} (${[...new Set(kinds)].join(', ')})`);
  }
  if (post.error) facts.push(`Error: ${post.error.message}`);

  sections.push(facts.join('<br>'));
  return sections.join('<br><br>');
}

/** The instant a post occupies on the calendar, or null if it has none. */
export function postInstant(post: BufferPost): Date | null {
  const raw = post.dueAt ?? post.sentAt;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function postEnd(start: Date, durationMinutes: number): Date {
  return new Date(start.getTime() + durationMinutes * 60_000);
}

/**
 * Renders Buffer posts as a standards-compliant Atom feed.
 *
 * Atom (RFC 4287) is the chosen format over RSS 2.0 because:
 *  - Atom requires `updated` timestamps, which we always have from Buffer
 *  - Atom has a well-defined `<content>` element for full post text
 *  - Atom's `link rel="alternate"` is unambiguous about the relationship to the
 *    web representation
 *  - Every modern RSS reader parses Atom; the reverse is less reliable
 *
 * Pure: takes posts and options in, returns the feed body. No I/O.
 *
 * Adapted from social-sindy, using the shared present.ts for post presentation.
 */

import type { BufferPost } from '../buffer/types.js';
import {
  eventTitle,
  eventDescriptionHtml,
  resolveChannel,
  serviceLabel,
  escapeXml,
  type ChannelRef,
} from '../present.js';

export type { ChannelRef };

const ATOM_NS = 'http://www.w3.org/2005/Atom';

/** Format a Date as an ISO 8601 / RFC 3339 timestamp for Atom. */
function iso8601(date: Date): string {
  return date.toISOString();
}

export interface AtomFeedOptions {
  /** Namespaces entry IDs so two feeds never collide in one reader. */
  feedId: string;
  name: string;
  subtitle?: string;
  /** Base URL of the app, used for feed self-link. */
  appUrl: string;
  /** The unguessable token in the feed URL. */
  feedToken: string;
  /** Whether to group cross-posts (same text, different channels). */
  groupCrossPosts: boolean;
}

/**
 * Group posts that have identical text across different channels — they're the
 * same content cross-posted. Each group becomes one entry with multiple
 * channel tags.
 */
function groupPosts(posts: BufferPost[]): Map<string, BufferPost[]> {
  const groups = new Map<string, BufferPost[]>();
  for (const post of posts) {
    // Group by normalized text content + same day (catches edits)
    const key = `${post.text.trim()}\n${new Date(post.sentAt ?? post.dueAt ?? post.createdAt).toISOString().slice(0, 10)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(post);
    } else {
      groups.set(key, [post]);
    }
  }
  return groups;
}

export function generateAtom(
  posts: BufferPost[],
  channels: Map<string, ChannelRef>,
  options: AtomFeedOptions,
  now: Date = new Date(),
): string {
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<feed xmlns="${ATOM_NS}">`);
  lines.push(`  <id>urn:social-sindy:${options.feedId}</id>`);
  lines.push(`  <title>${escapeXml(options.name)}</title>`);
  if (options.subtitle) {
    lines.push(`  <subtitle>${escapeXml(options.subtitle)}</subtitle>`);
  }
  lines.push(`  <link href="${escapeXml(options.appUrl)}/feed/${options.feedToken}.xml" rel="self" type="application/atom+xml"/>`);
  lines.push(`  <link href="${escapeXml(options.appUrl)}/" rel="alternate" type="text/html"/>`);
  lines.push(`  <updated>${iso8601(now)}</updated>`);
  lines.push(`  <generator uri="${escapeXml(options.appUrl)}" version="0.1">social sindy</generator>`);

  if (options.groupCrossPosts) {
    const groups = groupPosts(posts);
    for (const [, group] of groups) {
      const representative = group[0]!;
      const channelList = group.map((p) => resolveChannel(p, channels));
      emitEntry(lines, representative, channelList, options);
    }
  } else {
    for (const post of posts) {
      const channel = resolveChannel(post, channels);
      emitEntry(lines, post, [channel], options);
    }
  }

  lines.push('</feed>');
  return lines.join('\n') + '\n';
}

function emitEntry(
  lines: string[],
  post: BufferPost,
  channels: (ChannelRef | undefined)[],
  options: AtomFeedOptions,
): void {
  const published = post.sentAt ?? post.dueAt ?? post.createdAt;
  const updated = new Date(post.updatedAt);
  const title = eventTitle(post, channels[0], { showChannelInTitle: channels.length === 1 });

  lines.push('  <entry>');
  lines.push(`    <id>urn:social-sindy:post:${post.id}</id>`);
  lines.push(`    <title>${escapeXml(title)}</title>`);

  // Link to the post on Buffer (best-effort; Buffer doesn't document a canonical URL)
  if (post.externalLink) {
    lines.push(`    <link href="${escapeXml(post.externalLink)}" rel="alternate" type="text/html"/>`);
  }

  lines.push(`    <published>${iso8601(new Date(published))}</published>`);
  lines.push(`    <updated>${iso8601(updated)}</updated>`);

  // Channel tags: one <category> per channel, using the service name as term
  for (const ch of channels) {
    const service = ch?.service ?? post.channelService;
    lines.push(`    <category term="${escapeXml(serviceLabel(service))}"/>`);
  }

  // Tags from Buffer
  for (const tag of post.tags) {
    lines.push(`    <category term="${escapeXml(tag.name)}"/>`);
  }

  // Full post text as HTML content
  const description = eventDescriptionHtml(post, channels[0]);
  lines.push(`    <content type="html"><![CDATA[${description}]]></content>`);

  // Media attachments
  for (const asset of post.assets) {
    if (asset.source) {
      lines.push(`    <link href="${escapeXml(asset.source)}" rel="enclosure" type="${escapeXml(asset.mimeType ?? 'image/jpeg')}"/>`);
    }
  }

  lines.push('  </entry>');
}
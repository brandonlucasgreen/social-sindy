/**
 * Renders Buffer posts as a self-contained HTML page, meant to be embedded in
 * an iframe on someone's own website or link-in-bio page.
 *
 * Pure: takes posts and options in, returns the document. No I/O, and no
 * JavaScript in the output — the widget is static HTML and one inline
 * stylesheet, so it renders instantly, works with scripts blocked, and leaves
 * nothing running on the host page.
 *
 * Unlike the ICS and Atom feeds, this one is public by design: its URL is
 * pasted into a website. That is why the widget only ever carries published
 * posts (enforced where settings are read), and why it never links to Buffer
 * itself — only to the post on its own network.
 */

import { groupPosts } from '../atom/generate.js';
import type { BufferAsset, BufferPost } from '../buffer/types.js';
import { resolveChannel, serviceColor, serviceLabel, type ChannelRef } from '../present.js';
import { WIDGET_FONTS, type WidgetStyle } from './style.js';

export interface WidgetOptions {
  name: string;
  style: WidgetStyle;
  /** Combine identical posts across channels into one card. */
  groupCrossPosts: boolean;
  /** Most cards to show, counted after grouping. */
  maxCards: number;
  /** Owner's zone, used to date posts. Falls back to UTC if invalid. */
  timezone: string;
  appUrl: string;
}

/** Marks each post card, so the feed cache can count them. */
export const POST_MARKER = '<article class="post"';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only absolute http(s) URLs are ever emitted, so no `javascript:` link survives. */
function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * Escapes post text and turns bare URLs into links.
 *
 * URLs are found in the raw text and each segment is escaped separately, so a
 * URL can never absorb markup and escaped entities can never split a URL.
 */
export function linkify(text: string): string {
  let html = '';
  let last = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let url = match[0];
    const trailing = url.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    if (trailing) url = url.slice(0, -trailing.length);

    const href = safeUrl(url);
    html += escapeHtml(text.slice(last, start));
    html += href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
      : escapeHtml(url);
    last = start + url.length;
  }

  return html + escapeHtml(text.slice(last));
}

function postDate(post: BufferPost): Date {
  return new Date(post.sentAt ?? post.dueAt ?? post.createdAt);
}

function formatDate(date: Date, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(date);
  }
}

function imageFor(asset: BufferAsset): string | null {
  const isImage = asset.type === 'image' || asset.mimeType?.startsWith('image/');
  // A video's thumbnail is still an image worth showing; its source is not.
  return safeUrl(asset.thumbnail) ?? (isImage ? safeUrl(asset.source) : null);
}

const MAX_IMAGES = 4;

function renderPost(
  post: BufferPost,
  channels: (ChannelRef | undefined)[],
  options: WidgetOptions,
): string {
  const { style } = options;
  const date = postDate(post);
  const primary = channels[0];
  const service = primary?.service ?? post.channelService;
  const link = safeUrl(post.externalLink);

  const parts: string[] = [];
  parts.push(`${POST_MARKER} style="--net:${serviceColor(service)}">`);

  const meta: string[] = [];
  if (style.showChannel) {
    const names = channels.map((ch) => {
      const s = ch?.service ?? post.channelService;
      return `<span class="ch"><span class="dot" aria-hidden="true"></span>${escapeHtml(ch?.name ?? serviceLabel(s))}<span class="net"> · ${escapeHtml(serviceLabel(s))}</span></span>`;
    });
    meta.push(`<span class="chs">${names.join('')}</span>`);
  }
  meta.push(
    `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(formatDate(date, options.timezone))}</time>`,
  );
  parts.push(`<header>${meta.join('')}</header>`);

  if (post.text?.trim()) parts.push(`<p class="text">${linkify(post.text.trim())}</p>`);

  if (style.showMedia) {
    const images = post.assets.map(imageFor).filter((u): u is string => u !== null).slice(0, MAX_IMAGES);
    if (images.length) {
      parts.push(
        `<div class="media n${images.length}">${images
          .map((src) => `<img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async">`)
          .join('')}</div>`,
      );
    }
  }

  if (link) {
    parts.push(
      `<a class="view" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">View on ${escapeHtml(serviceLabel(service))} →</a>`,
    );
  }

  parts.push('</article>');
  return parts.join('');
}

function stylesheet(style: WidgetStyle): string {
  const font = WIDGET_FONTS[style.font];
  const light = `--bg:#ffffff;--card:hsl(210 20% 98%);--text:hsl(210 15% 16%);--dim:hsl(210 10% 42%);--line:hsl(210 16% 88%);`;
  const dark = `--bg:hsl(210 12% 14%);--card:hsl(210 12% 18%);--text:hsl(210 20% 96%);--dim:hsl(210 10% 70%);--line:hsl(210 6% 27%);`;

  // A transparent iframe only stays transparent if its color-scheme matches the
  // host page's, and the host's is unknowable — declaring none ('normal')
  // matches the common case, and the palette below still follows the theme.
  const scheme = style.transparent
    ? ''
    : `color-scheme:${style.theme === 'auto' ? 'light dark' : style.theme};`;

  const palette =
    style.theme === 'light'
      ? `:root{${light}}`
      : style.theme === 'dark'
        ? `:root{${dark}}`
        : `:root{${light}}@media (prefers-color-scheme: dark){:root{${dark}}}`;

  return [
    palette,
    `:root{${scheme}--accent:${style.accent};--radius:${style.radius}px;--size:${style.fontSize}px}`,
    `*{box-sizing:border-box}`,
    `html,body{margin:0;padding:0}`,
    `body{background:${style.transparent ? 'transparent' : 'var(--bg)'};color:var(--text);font-family:${font.stack};font-size:var(--size);line-height:1.5;-webkit-font-smoothing:antialiased;padding:12px}`,
    `a{color:var(--accent)}`,
    `.head{font-weight:600;font-size:1.1em;margin:0 0 10px;padding:0 2px}`,
    `.feed{display:flex;flex-direction:column;gap:10px}`,
    `.post{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px}`,
    `.post header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 10px;font-size:.85em;color:var(--dim);margin-bottom:6px}`,
    `.chs{display:flex;flex-wrap:wrap;gap:2px 10px}`,
    `.ch{color:var(--text);font-weight:600}`,
    `.net{color:var(--dim);font-weight:400}`,
    `.dot{display:inline-block;width:.55em;height:.55em;border-radius:50%;background:var(--net);margin-right:.4em;vertical-align:.08em}`,
    `.text{margin:0;white-space:pre-line;overflow-wrap:anywhere}`,
    `.media{display:grid;gap:4px;margin-top:10px;border-radius:calc(var(--radius) * .7);overflow:hidden}`,
    `.media.n2,.media.n4{grid-template-columns:1fr 1fr}.media.n3{grid-template-columns:2fr 1fr 1fr}`,
    `.media img{display:block;width:100%;height:100%;max-height:360px;object-fit:cover;background:var(--line)}`,
    `.media.n1 img{height:auto}`,
    `.view{display:inline-block;margin-top:8px;font-size:.85em;font-weight:600;text-decoration:none}`,
    `.view:hover{text-decoration:underline}`,
    `.empty{color:var(--dim);text-align:center;padding:24px 0}`,
    `.foot{margin-top:10px;text-align:center;font-size:.75em;color:var(--dim)}`,
    `.foot a{color:inherit}`,
  ].join('\n');
}

export function generateWidget(
  posts: BufferPost[],
  channels: Map<string, ChannelRef>,
  options: WidgetOptions,
): string {
  const { style } = options;

  // Newest first: a widget is a "latest posts" strip, not a history.
  const sorted = [...posts].sort((a, b) => postDate(b).getTime() - postDate(a).getTime());

  const groups = options.groupCrossPosts ? [...groupPosts(sorted).values()] : sorted.map((p) => [p]);
  const cards = groups
    .slice(0, Math.max(0, options.maxCards))
    .map((group) => renderPost(group[0]!, group.map((p) => resolveChannel(p, channels)), options));

  const font = WIDGET_FONTS[style.font];
  const fontLink = font.webFont
    ? `<link rel="stylesheet" href="https://api.fonts.coollabs.io/css2?family=${font.webFont}&display=swap">`
    : '';

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(options.name)}</title>`,
    `<base target="_blank">`,
    fontLink,
    `<style>${stylesheet(style)}</style>`,
    '</head>',
    '<body>',
    style.showHeader ? `<div class="head">${escapeHtml(options.name)}</div>` : '',
    `<main class="feed">${cards.length ? cards.join('\n') : '<p class="empty">No posts yet.</p>'}</main>`,
    `<div class="foot">via <a href="${escapeHtml(options.appUrl.replace(/\/$/, ''))}/" rel="noopener">social sindy</a></div>`,
    '</body>',
    '</html>',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

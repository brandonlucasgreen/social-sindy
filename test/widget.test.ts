import { describe, expect, it } from 'vitest';

import type { BufferPost } from '../src/buffer/types.js';
import { POST_MARKER, generateWidget, linkify, type WidgetOptions } from '../src/widget/generate.js';
import {
  DEFAULT_WIDGET_STYLE,
  embedSnippet,
  normalizeWidgetStyle,
  parseWidgetStyle,
  serializeWidgetStyle,
} from '../src/widget/style.js';

const post = (overrides: Partial<BufferPost> = {}): BufferPost => ({
  id: 'post_1',
  status: 'sent',
  text: 'New single out Friday',
  dueAt: '2026-07-27T10:00:00.000Z',
  sentAt: '2026-07-27T10:00:00.000Z',
  createdAt: '2026-07-25T12:00:00.000Z',
  updatedAt: '2026-07-27T10:00:00.000Z',
  channelId: 'ch_1',
  channelService: 'bluesky',
  shareMode: null,
  externalLink: null,
  tags: [],
  error: null,
  assets: [],
  channel: { id: 'ch_1', name: 'kidlightbulbs', displayName: null, service: 'bluesky' },
  ...overrides,
});

const channels = new Map([['ch_1', { id: 'ch_1', name: 'kidlightbulbs', service: 'bluesky' }]]);

const options = (overrides: Partial<WidgetOptions> = {}): WidgetOptions => ({
  name: 'Latest posts',
  style: DEFAULT_WIDGET_STYLE,
  groupCrossPosts: false,
  maxCards: 10,
  timezone: 'UTC',
  appUrl: 'https://socialsindy.com',
  ...overrides,
});

const count = (html: string) => html.split(POST_MARKER).length - 1;

describe('generateWidget', () => {
  it('renders a complete document with one card per post, newest first', () => {
    const html = generateWidget(
      [
        post({ id: 'old', text: 'older', sentAt: '2026-07-01T10:00:00.000Z' }),
        post({ id: 'new', text: 'newer', sentAt: '2026-07-20T10:00:00.000Z' }),
      ],
      channels,
      options(),
    );

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(count(html)).toBe(2);
    expect(html.indexOf('newer')).toBeLessThan(html.indexOf('older'));
    expect(html).toContain('Jul 20, 2026');
  });

  it('contains no script at all', () => {
    const html = generateWidget([post({ text: '<script>alert(1)</script>' })], channels, options());
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the title and channel names', () => {
    const html = generateWidget(
      [post({ channel: { id: 'ch_1', name: '<b>x</b>', displayName: null, service: 'bluesky' } })],
      channels,
      options({ name: '"><img src=x onerror=alert(1)>' }),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>x</b>');
  });

  it('caps cards after grouping, so a cross-post counts once', () => {
    const posts = [
      post({ id: 'a1', channelId: 'ch_1', text: 'same' }),
      post({ id: 'a2', channelId: 'ch_2', text: 'same', channel: { id: 'ch_2', name: 'kl', displayName: null, service: 'threads' } }),
      post({ id: 'b', text: 'different', sentAt: '2026-07-26T10:00:00.000Z' }),
    ];

    expect(count(generateWidget(posts, channels, options({ groupCrossPosts: true, maxCards: 2 })))).toBe(2);
    expect(count(generateWidget(posts, channels, options({ groupCrossPosts: false, maxCards: 2 })))).toBe(2);
    expect(count(generateWidget(posts, channels, options({ groupCrossPosts: true, maxCards: 10 })))).toBe(2);
    expect(count(generateWidget(posts, channels, options({ groupCrossPosts: false, maxCards: 10 })))).toBe(3);
  });

  it('links to the post on its network, never to Buffer', () => {
    const html = generateWidget(
      [post({ externalLink: 'https://bsky.app/profile/kid/post/1' })],
      channels,
      options(),
    );
    expect(html).toContain('href="https://bsky.app/profile/kid/post/1"');
    expect(html).toContain('View on Bluesky');
    expect(html).not.toContain('publish.buffer.com');
  });

  it('drops a non-http external link', () => {
    const html = generateWidget([post({ externalLink: 'javascript:alert(1)' })], channels, options());
    expect(html).not.toContain('javascript:');
  });

  it('shows images only when enabled, and only http(s) ones', () => {
    const assets = [
      { type: 'image', mimeType: 'image/jpeg', source: 'https://cdn.example/a.jpg', thumbnail: null },
      { type: 'image', mimeType: 'image/png', source: 'data:image/png;base64,AAAA', thumbnail: null },
    ];
    const on = generateWidget([post({ assets })], channels, options());
    expect(on).toContain('src="https://cdn.example/a.jpg"');
    expect(on).not.toContain('data:image/png');

    const off = generateWidget([post({ assets })], channels, options({ style: { ...DEFAULT_WIDGET_STYLE, showMedia: false } }));
    expect(off).not.toContain('cdn.example');
  });

  it('only loads a web font when one is chosen', () => {
    expect(generateWidget([], channels, options())).not.toContain('fonts.coollabs.io');
    const html = generateWidget([], channels, options({ style: { ...DEFAULT_WIDGET_STYLE, font: 'inter' } }));
    expect(html).toContain('https://api.fonts.coollabs.io/css2?family=Inter');
  });

  it('renders an empty state rather than an empty box', () => {
    expect(generateWidget([], channels, options())).toContain('No posts yet.');
  });

  it('falls back to UTC for an invalid owner timezone', () => {
    expect(() => generateWidget([post()], channels, options({ timezone: 'Not/AZone' }))).not.toThrow();
  });
});

describe('linkify', () => {
  it('links bare URLs and leaves trailing punctuation outside the link', () => {
    expect(linkify('Out now: https://kidlightbulbs.com/new.')).toBe(
      'Out now: <a href="https://kidlightbulbs.com/new" target="_blank" rel="noopener noreferrer">https://kidlightbulbs.com/new</a>.',
    );
  });

  it('never lets a URL carry markup or a quote into the attribute', () => {
    const html = linkify('https://x.test/"onmouseover="alert(1) <b>');
    expect(html).not.toContain('"onmouseover');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('widget style', () => {
  it('defaults every field from garbage', () => {
    expect(normalizeWidgetStyle({})).toEqual(DEFAULT_WIDGET_STYLE);
    expect(parseWidgetStyle('not json')).toEqual(DEFAULT_WIDGET_STYLE);
    expect(parseWidgetStyle(null)).toEqual(DEFAULT_WIDGET_STYLE);
  });

  it('rejects anything that could escape into CSS', () => {
    const style = normalizeWidgetStyle({
      accent: 'red;}body{display:none',
      font: 'Comic Sans"; }',
      theme: 'neon',
      fontSize: '99',
      radius: '3',
    });
    expect(style.accent).toBe(DEFAULT_WIDGET_STYLE.accent);
    expect(style.font).toBe(DEFAULT_WIDGET_STYLE.font);
    expect(style.theme).toBe(DEFAULT_WIDGET_STYLE.theme);
    expect(style.fontSize).toBe(DEFAULT_WIDGET_STYLE.fontSize);
    expect(style.radius).toBe(DEFAULT_WIDGET_STYLE.radius);
  });

  it('clamps dimensions, keeping 0 as "fill the container"', () => {
    expect(normalizeWidgetStyle({ width: '0' }).width).toBe(0);
    expect(normalizeWidgetStyle({ width: '50' }).width).toBe(240);
    expect(normalizeWidgetStyle({ width: '99999' }).width).toBe(1600);
    expect(normalizeWidgetStyle({ height: '10' }).height).toBe(200);
    expect(normalizeWidgetStyle({ height: 'tall' }).height).toBe(DEFAULT_WIDGET_STYLE.height);
  });

  it('round-trips through storage', () => {
    const style = { ...DEFAULT_WIDGET_STYLE, theme: 'dark' as const, accent: '#ff00aa', width: 400 };
    expect(parseWidgetStyle(serializeWidgetStyle(style))).toEqual(style);
  });

  it('puts dimensions on the iframe and escapes the title', () => {
    const snippet = embedSnippet('https://socialsindy.com/', 'tok', 'A "quoted" title', {
      ...DEFAULT_WIDGET_STYLE,
      width: 400,
      height: 500,
    });
    expect(snippet).toContain('src="https://socialsindy.com/embed/tok"');
    expect(snippet).toContain('max-width:400px');
    expect(snippet).toContain('height:500px');
    expect(snippet).toContain('title="A &quot;quoted&quot; title"');
  });

  // A browser paints an opaque canvas behind an iframe whose element and page
  // disagree on color-scheme, which turned "transparent" into solid white.
  it('declares the same color-scheme on the iframe and the widget page', () => {
    for (const theme of ['auto', 'light', 'dark'] as const) {
      const style = { ...DEFAULT_WIDGET_STYLE, theme, transparent: true };
      const scheme = theme === 'auto' ? 'light dark' : theme;
      expect(embedSnippet('https://socialsindy.com', 'tok', 'W', style)).toContain(`color-scheme:${scheme};`);
      expect(generateWidget([], channels, options({ style }))).toContain(`color-scheme:${scheme};`);
    }
  });
});

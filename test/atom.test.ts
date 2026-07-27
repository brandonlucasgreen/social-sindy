import { describe, it, expect } from 'vitest';
import { generateAtom } from '../src/atom/generate.js';
import type { BufferPost } from '../src/buffer/types.js';

const mockPost = (overrides: Partial<BufferPost> = {}): BufferPost => ({
  id: 'post_1',
  status: 'sent',
  text: 'Hello world',
  dueAt: '2026-07-27T10:00:00.000Z',
  sentAt: '2026-07-27T10:00:00.000Z',
  createdAt: '2026-07-25T12:00:00.000Z',
  updatedAt: '2026-07-27T10:00:00.000Z',
  channelId: 'ch_1',
  channelService: 'bluesky',
  shareMode: null,
  tags: [],
  error: null,
  assets: [],
  channel: { id: 'ch_1', name: 'My Channel', displayName: 'My Channel', service: 'bluesky' },
  ...overrides,
});

describe('generateAtom', () => {
  it('produces a valid Atom feed with one entry', () => {
    const posts = [mockPost()];
    const channels = new Map([['ch_1', { id: 'ch_1', name: 'My Channel', service: 'bluesky' }]]);

    const xml = generateAtom(posts, channels, {
      feedId: 'out_1',
      name: 'Test Feed',
      subtitle: 'Test subtitle',
      appUrl: 'https://social-sindy.bgreen.lol',
      feedToken: 'abc123',
      groupCrossPosts: false,
    });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('<title>Test Feed</title>');
    expect(xml).toContain('<entry>');
    expect(xml).toContain('<id>urn:social-sindy:post:post_1</id>');
    expect(xml).toContain('</feed>');
    expect(xml.trim().endsWith('</feed>')).toBe(true);
  });

  it('escapes XML special characters in text', () => {
    const posts = [mockPost({ text: '<script>alert("xss")</script> & stuff' })];
    const channels = new Map([['ch_1', { id: 'ch_1', name: 'My Channel', service: 'bluesky' }]]);

    const xml = generateAtom(posts, channels, {
      feedId: 'out_1',
      name: 'Test Feed',
      appUrl: 'https://social-sindy.bgreen.lol',
      feedToken: 'abc123',
      groupCrossPosts: false,
    });

    expect(xml).not.toContain('<script>');
    expect(xml).toContain('&lt;script&gt;');
  });

  it('groups cross-posts when enabled', () => {
    const posts = [
      mockPost({ id: 'post_1', channelId: 'ch_1', channelService: 'bluesky' }),
      mockPost({ id: 'post_2', channelId: 'ch_2', channelService: 'threads', channel: { id: 'ch_2', name: 'Threads', displayName: 'Threads', service: 'threads' } }),
    ];
    const channels = new Map([
      ['ch_1', { id: 'ch_1', name: 'My Channel', service: 'bluesky' }],
      ['ch_2', { id: 'ch_2', name: 'Threads', service: 'threads' }],
    ]);

    const xml = generateAtom(posts, channels, {
      feedId: 'out_1',
      name: 'Test Feed',
      appUrl: 'https://social-sindy.bgreen.lol',
      feedToken: 'abc123',
      groupCrossPosts: true,
    });

    // Both posts have identical text, so they should be grouped into one entry
    const entryCount = (xml.match(/<entry>/g) ?? []).length;
    expect(entryCount).toBe(1);
  });

  it('does not group cross-posts when disabled', () => {
    const posts = [
      mockPost({ id: 'post_1', channelId: 'ch_1', channelService: 'bluesky' }),
      mockPost({ id: 'post_2', channelId: 'ch_2', channelService: 'threads', channel: { id: 'ch_2', name: 'Threads', displayName: 'Threads', service: 'threads' } }),
    ];
    const channels = new Map([
      ['ch_1', { id: 'ch_1', name: 'My Channel', service: 'bluesky' }],
      ['ch_2', { id: 'ch_2', name: 'Threads', service: 'threads' }],
    ]);

    const xml = generateAtom(posts, channels, {
      feedId: 'out_1',
      name: 'Test Feed',
      appUrl: 'https://social-sindy.bgreen.lol',
      feedToken: 'abc123',
      groupCrossPosts: false,
    });

    const entryCount = (xml.match(/<entry>/g) ?? []).length;
    expect(entryCount).toBe(2);
  });

  it('includes self-link with feed token', () => {
    const posts: BufferPost[] = [];
    const channels = new Map();

    const xml = generateAtom(posts, channels, {
      feedId: 'out_1',
      name: 'Test Feed',
      appUrl: 'https://social-sindy.bgreen.lol',
      feedToken: 'secret_token_123',
      groupCrossPosts: false,
    });

    expect(xml).toContain('href="https://social-sindy.bgreen.lol/feed/secret_token_123.xml"');
    expect(xml).toContain('rel="self"');
  });

  it('handles empty posts list', () => {
    const xml = generateAtom([], new Map(), {
      feedId: 'out_1',
      name: 'Empty Feed',
      appUrl: 'https://social-sindy.bgreen.lol',
      feedToken: 'abc123',
      groupCrossPosts: false,
    });

    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('</feed>');
    expect(xml).not.toContain('<entry>');
  });
});
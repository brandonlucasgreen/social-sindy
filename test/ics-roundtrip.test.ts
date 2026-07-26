/**
 * Round-trips generated feeds through an independent iCalendar parser.
 *
 * The unit tests assert what we emit; these assert that a real client can read
 * it back unchanged. Fixtures are actual posts from a live Buffer account, so
 * the awkward cases are the ones that genuinely occur: emoji, embedded blank
 * lines, trailing whitespace, hashtags, and URLs.
 */

import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';

import type { BufferPost } from '../src/buffer/types.js';
import { generateIcs, type ChannelRef } from '../src/ics/generate.js';

const channels = new Map<string, ChannelRef>();

const options = {
  calendarId: 'cal_roundtrip',
  name: 'Buffer — Cult of Lightbulbs',
  description: 'Scheduled posts',
  timezone: 'America/New_York',
  eventDurationMinutes: 30,
  refreshMinutes: 60,
  showChannelInTitle: true,
};

const NOW = new Date('2026-07-26T10:00:00.000Z');

function makePost(overrides: Partial<BufferPost>): BufferPost {
  return {
    id: 'post',
    status: 'sent',
    text: '',
    dueAt: '2026-07-24T18:15:21.761Z',
    sentAt: null,
    createdAt: '2026-07-24T18:15:21.717Z',
    updatedAt: '2026-07-24T18:15:21.717Z',
    channelId: 'ch',
    channelService: 'threads',
    shareMode: 'shareNow',
    tags: [],
    error: null,
    assets: [],
    channel: { id: 'ch', name: 'kidlightbulbs', displayName: null, service: 'threads' },
    ...overrides,
  };
}

/** Verbatim posts from a live Buffer account. */
const REAL_POSTS: BufferPost[] = [
  makePost({
    id: '6a63abb9b759dd36830cf0fd',
    text: 'Free business and/or event idea: \n\nblues clues booze cruise\n\nInterpret as you like',
    dueAt: '2026-07-24T18:15:21.761Z',
    sentAt: '2026-07-24T18:15:30.133Z',
  }),
  makePost({
    id: '6a6384356b5099e00350b330',
    text: 'Sometimes the right thing to do is just close the laptop and open a book',
    dueAt: '2026-07-24T20:12:00.000Z',
    sentAt: '2026-07-24T20:12:00.968Z',
    channelId: 'ch_li',
    channelService: 'linkedin',
    shareMode: 'addToQueue',
    channel: { id: 'ch_li', name: 'brandonlgreen', displayName: 'Brandon Lucas Green', service: 'linkedin' },
  }),
  makePost({
    id: '6a60c9abd5eb72c2a10ca1d2',
    // Note the trailing space after the emoji, and the blank line.
    text: 'What is everyone listening to while they work today?\n\nThere are correct and incorrect answers to this question 🤔 ',
    dueAt: '2026-07-22T13:46:19.151Z',
    sentAt: '2026-07-22T13:46:19.387Z',
    channelId: 'ch_bsky',
    channelService: 'bluesky',
    channel: { id: 'ch_bsky', name: 'brandon lucas green', displayName: null, service: 'bluesky' },
  }),
  makePost({
    id: '6a5e4200f49c0e22b7d5c650',
    status: 'scheduled',
    text: 'The average Spotify stream pays an artist about $0.003.\n\nOne album purchase on Bandcamp is worth thousands of streams.\n\nUnstream helps you find where to buy music directly from the artists you love.\n\nhttps://unstream.stream\n\n#music #fairtrademusic #supportartists #indiemusic #buymusic #bandcamp',
    dueAt: '2026-08-02T13:00:00.000Z',
    sentAt: null,
    channelId: 'ch_ig',
    channelService: 'instagram',
    shareMode: 'customScheduled',
    tags: [{ id: 't1', name: 'Unstream' }],
    assets: [
      {
        type: 'image',
        mimeType: 'image/png',
        source: 'https://unstream.stream/og-image.png',
        thumbnail: 'https://unstream.stream/og-image.png',
      },
    ],
    channel: { id: 'ch_ig', name: 'unstream.stream', displayName: null, service: 'instagram' },
  }),
];

function parse(ics: string) {
  const component = new ICAL.Component(ICAL.parse(ics));
  return {
    component,
    events: component.getAllSubcomponents('vevent').map((vevent) => new ICAL.Event(vevent)),
  };
}

describe('generated feeds parse with an independent iCalendar parser', () => {
  const ics = generateIcs(REAL_POSTS, channels, options, NOW);

  it('parses without error', () => {
    expect(() => ICAL.parse(ics)).not.toThrow();
  });

  it('yields one event per scheduled post', () => {
    expect(parse(ics).events).toHaveLength(REAL_POSTS.length);
  });

  it('preserves calendar-level metadata', () => {
    const { component } = parse(ics);

    expect(component.getFirstPropertyValue('x-wr-calname')).toBe('Buffer — Cult of Lightbulbs');
    expect(component.getFirstPropertyValue('x-wr-timezone')).toBe('America/New_York');
    expect(String(component.getFirstPropertyValue('refresh-interval'))).toBe('PT1H');
  });

  it('round-trips embedded blank lines in post text', () => {
    const event = parse(ics).events.find((e) => e.uid.startsWith('6a60c9abd5eb72c2a10ca1d2'))!;

    // Interior blank lines are meaningful and preserved; surrounding whitespace
    // is trimmed, since it is invisible noise in an event description.
    expect(event.description).toContain(
      'What is everyone listening to while they work today?\n\nThere are correct and incorrect answers to this question 🤔',
    );
    expect(event.description.startsWith('What is')).toBe(true);
  });

  it('round-trips emoji in both summary and description', () => {
    const event = parse(ics).events.find((e) => e.uid.startsWith('6a60c9abd5eb72c2a10ca1d2'))!;

    expect(event.summary).toContain('🦋');
    expect(event.description).toContain('🤔');
    expect(ics).not.toContain('�');
  });

  it('round-trips a long post with hashtags, a URL, and commas intact', () => {
    const event = parse(ics).events.find((e) => e.uid.startsWith('6a5e4200f49c0e22b7d5c650'))!;

    expect(event.description).toContain('$0.003.');
    expect(event.description).toContain('https://unstream.stream');
    expect(event.description).toContain('#music #fairtrademusic #supportartists');
    // The comma and semicolon escapes must survive unescaping exactly once.
    expect(event.description).not.toContain('\\,');
  });

  it('places events at the right instant with the configured duration', () => {
    const event = parse(ics).events.find((e) => e.uid.startsWith('6a6384356b5099e00350b330'))!;

    expect(event.startDate.toJSDate().toISOString()).toBe('2026-07-24T20:12:00.000Z');
    expect(event.endDate.toJSDate().toISOString()).toBe('2026-07-24T20:42:00.000Z');
  });

  it('prefers displayName for the channel shown in the title', () => {
    const event = parse(ics).events.find((e) => e.uid.startsWith('6a6384356b5099e00350b330'))!;

    expect(event.summary).toBe(
      '💼 Brandon Lucas Green: Sometimes the right thing to do is just close the laptop and…',
    );
  });

  it('exposes the Buffer link and the tags', () => {
    const vevent = parse(ics)
      .component.getAllSubcomponents('vevent')
      .find((c) => String(c.getFirstPropertyValue('uid')).startsWith('6a5e4200f49c0e22b7d5c650'))!;

    expect(vevent.getFirstPropertyValue('url')).toBe(
      'https://publish.buffer.com/post/6a5e4200f49c0e22b7d5c650',
    );
    // CATEGORIES is multi-valued, and a conforming parser splits it on commas.
    expect(vevent.getFirstProperty('categories')!.getValues()).toEqual(['Instagram', 'Unstream']);
    expect(vevent.getFirstPropertyValue('attach')).toBe('https://unstream.stream/og-image.png');
  });

  it('round-trips text engineered to land a fold inside a multi-byte character', () => {
    // Walk the offset so the 75-octet boundary falls at every position within a
    // 4-byte emoji, which is where naive folding corrupts output.
    for (let pad = 0; pad < 8; pad++) {
      const post = makePost({ id: `pad_${pad}`, text: `${'a'.repeat(pad)}${'🧵'.repeat(30)}` });
      const generated = generateIcs([post], channels, options, NOW);

      expect(() => ICAL.parse(generated)).not.toThrow();
      expect(generated).not.toContain('�');

      const event = parse(generated).events[0]!;
      expect(event.description).toContain(`${'a'.repeat(pad)}${'🧵'.repeat(30)}`);
    }
  });

  it('round-trips text containing every TEXT metacharacter', () => {
    const nasty = 'semi; comma, backslash\\ newline\nend';
    const generated = generateIcs([makePost({ text: nasty })], channels, options, NOW);

    expect(parse(generated).events[0]!.description).toContain(nasty);
  });

  it('produces a feed with no events when nothing is scheduled', () => {
    const empty = generateIcs([], channels, options, NOW);

    expect(() => ICAL.parse(empty)).not.toThrow();
    expect(parse(empty).events).toHaveLength(0);
  });
});

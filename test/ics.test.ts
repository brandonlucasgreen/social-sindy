import { describe, expect, it } from 'vitest';

import type { BufferPost } from '../src/buffer/types.js';
import { excerpt, generateIcs, type ChannelRef } from '../src/ics/generate.js';
import { escapeText, foldLine, formatDuration, formatUtc } from '../src/ics/serialize.js';

const encoder = new TextEncoder();
const octets = (s: string) => encoder.encode(s).length;

/**
 * Reverses RFC 5545 line folding, for assertions on content that is long enough
 * to be split across continuation lines.
 */
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

describe('escapeText', () => {
  it('escapes the four TEXT metacharacters', () => {
    expect(escapeText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
  });

  it('escapes backslashes before introducing new ones', () => {
    // A naive implementation that escapes commas first would produce `\\,`.
    expect(escapeText('\\,')).toBe('\\\\\\,');
  });

  it('normalizes CRLF and bare CR to a single escaped newline', () => {
    expect(escapeText('a\r\nb\rc')).toBe('a\\nb\\nc');
  });

  it('drops control characters that are invalid in a TEXT value', () => {
    expect(escapeText('a\x00b\x07c')).toBe('abc');
  });
});

describe('foldLine', () => {
  it('leaves short lines untouched', () => {
    expect(foldLine('SUMMARY:hello')).toBe('SUMMARY:hello');
  });

  it('folds long ASCII lines with a leading space on continuations', () => {
    const line = `SUMMARY:${'a'.repeat(200)}`;
    const segments = foldLine(line).split('\r\n');

    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]).toHaveLength(75);
    for (const segment of segments.slice(1)) expect(segment.startsWith(' ')).toBe(true);
    // Unfolding is defined as removing the CRLF and the single leading space.
    expect(segments.map((s, i) => (i === 0 ? s : s.slice(1))).join('')).toBe(line);
  });

  it('measures the limit in octets, not characters', () => {
    // 40 three-octet characters is 120 octets but only 40 JS characters, so a
    // character-counting implementation would not fold this at all.
    const line = `SUMMARY:${'あ'.repeat(40)}`;
    const segments = foldLine(line).split('\r\n');

    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) expect(octets(segment)).toBeLessThanOrEqual(75);
  });

  it('never splits a multi-byte character', () => {
    const line = `DESCRIPTION:${'🧵 supporting artists directly '.repeat(12)}`;
    const folded = foldLine(line);

    // A fold inside a UTF-8 sequence surfaces as U+FFFD after decoding.
    expect(folded).not.toContain('�');
    const unfolded = folded
      .split('\r\n')
      .map((s, i) => (i === 0 ? s : s.slice(1)))
      .join('');
    expect(unfolded).toBe(line);
  });
});

describe('formatUtc', () => {
  it('formats an instant as a UTC date-time', () => {
    expect(formatUtc(new Date('2026-08-02T13:00:00.000Z'))).toBe('20260802T130000Z');
  });

  it('pads every component', () => {
    expect(formatUtc(new Date('2026-01-05T04:03:02.000Z'))).toBe('20260105T040302Z');
  });
});

describe('formatDuration', () => {
  it('prefers the largest tidy unit', () => {
    expect(formatDuration(15)).toBe('PT15M');
    expect(formatDuration(60)).toBe('PT1H');
    expect(formatDuration(90)).toBe('PT90M');
    expect(formatDuration(360)).toBe('PT6H');
    expect(formatDuration(1440)).toBe('P1D');
  });
});

describe('excerpt', () => {
  it('collapses whitespace onto one line', () => {
    expect(excerpt('one\n\ntwo   three')).toBe('one two three');
  });

  it('truncates on code point boundaries', () => {
    const result = excerpt('🧵'.repeat(80), 5);
    expect(result).toBe(`${'🧵'.repeat(5)}…`);
  });

  it('returns empty string for media-only posts', () => {
    expect(excerpt(null)).toBe('');
    expect(excerpt('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------

const channels = new Map<string, ChannelRef>([
  ['ch_threads', { id: 'ch_threads', name: 'kidlightbulbs', service: 'threads' }],
  ['ch_insta', { id: 'ch_insta', name: 'unstream.stream', service: 'instagram' }],
]);

function post(overrides: Partial<BufferPost> = {}): BufferPost {
  return {
    id: 'post_1',
    status: 'scheduled',
    text: 'Buy music directly from artists, not streams.',
    dueAt: '2026-08-02T13:00:00.000Z',
    sentAt: null,
    createdAt: '2026-07-20T15:42:55.553Z',
    updatedAt: '2026-07-21T08:15:00.000Z',
    channelId: 'ch_threads',
    channelService: 'threads',
    shareMode: 'customScheduled',
    tags: [],
    error: null,
    assets: [],
    channel: {
      id: 'ch_threads',
      name: 'kidlightbulbs',
      displayName: 'kidlightbulbs',
      service: 'threads',
    },
    ...overrides,
  };
}

const options = {
  calendarId: 'cal_abc',
  name: 'Buffer — Cult of Lightbulbs',
  description: 'Scheduled posts',
  timezone: 'America/New_York',
  eventDurationMinutes: 15,
  refreshMinutes: 60,
  showChannelInTitle: true,
};

const NOW = new Date('2026-07-26T10:00:00.000Z');

describe('generateIcs', () => {
  it('emits a well-formed calendar wrapper', () => {
    const ics = generateIcs([], channels, options, NOW);

    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('CALSCALE:GREGORIAN');
    expect(ics).toContain('X-WR-CALNAME:Buffer — Cult of Lightbulbs');
  });

  it('advertises the refresh interval in both properties', () => {
    const ics = generateIcs([], channels, { ...options, refreshMinutes: 360 }, NOW);

    expect(ics).toContain('X-PUBLISHED-TTL:PT6H');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT6H');
  });

  it('uses CRLF line endings throughout', () => {
    const ics = generateIcs([post()], channels, options, NOW);

    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it('keeps every content line within 75 octets', () => {
    const long = post({
      id: 'post_long',
      text: `🧵 ${'The average Spotify stream pays an artist about $0.003. '.repeat(8)}`,
      assets: [
        {
          type: 'image',
          mimeType: 'image/png',
          source: `https://unstream.stream/${'a'.repeat(120)}.png`,
          thumbnail: null,
        },
      ],
    });

    for (const line of generateIcs([long], channels, options, NOW).split('\r\n')) {
      expect(octets(line)).toBeLessThanOrEqual(75);
    }
  });

  it('derives DTEND from the configured duration', () => {
    const ics = generateIcs([post()], channels, { ...options, eventDurationMinutes: 45 }, NOW);

    expect(ics).toContain('DTSTART:20260802T130000Z');
    expect(ics).toContain('DTEND:20260802T134500Z');
  });

  it('namespaces UIDs per calendar so two feeds can coexist', () => {
    const a = generateIcs([post()], channels, options, NOW);
    const b = generateIcs([post()], channels, { ...options, calendarId: 'cal_xyz' }, NOW);

    expect(a).toContain('UID:post_1.cal_abc@buffer-gcal');
    expect(b).toContain('UID:post_1.cal_xyz@buffer-gcal');
  });

  it('titles events with channel name and service emoji', () => {
    const ics = generateIcs([post()], channels, options, NOW);

    expect(ics).toContain('SUMMARY:🧵 kidlightbulbs: Buy music directly from artists\\, not stre');
  });

  it('omits the channel prefix when configured off', () => {
    const ics = generateIcs([post()], channels, { ...options, showChannelInTitle: false }, NOW);

    expect(ics).toContain('SUMMARY:Buy music directly from artists\\, not streams.');
    expect(ics).not.toContain('🧵 kidlightbulbs');
  });

  it('falls back to a service label for media-only posts', () => {
    const mediaOnly = post({
      text: '',
      channelId: 'ch_insta',
      channelService: 'instagram',
      channel: {
        id: 'ch_insta',
        name: 'unstream.stream',
        displayName: 'unstream.stream',
        service: 'instagram',
      },
    });

    expect(generateIcs([mediaOnly], channels, options, NOW)).toContain(
      'SUMMARY:📸 unstream.stream: Instagram post',
    );
  });

  it('emits LAST-MODIFIED from the post\'s own updatedAt', () => {
    // Distinguishes a real edit from the feed merely being regenerated, whose
    // timestamp lands in DTSTAMP instead.
    const ics = generateIcs([post({ updatedAt: '2026-07-21T08:15:00.000Z' })], channels, options, NOW);

    expect(ics).toContain('LAST-MODIFIED:20260721T081500Z');
    expect(ics).toContain('DTSTAMP:20260726T100000Z');
  });

  it('omits LAST-MODIFIED rather than emitting an invalid date', () => {
    const ics = generateIcs([post({ updatedAt: 'nonsense' })], channels, options, NOW);

    expect(ics).not.toContain('LAST-MODIFIED');
    expect(ics).toContain('BEGIN:VEVENT');
  });

  it('prefers the live inline channel name over the stored selection', () => {
    // A channel renamed in Buffer since setup should title events with the new
    // name, not the one captured when the calendar was created.
    const renamed = post({
      channel: { id: 'ch_threads', name: 'kidlightbulbs', displayName: 'Kid Lightbulbs ✨', service: 'threads' },
    });

    expect(generateIcs([renamed], channels, options, NOW)).toContain('SUMMARY:🧵 Kid Lightbulbs ✨:');
  });

  it('marks unpublished states TENTATIVE and flags errors', () => {
    const drafts = generateIcs([post({ status: 'draft' })], channels, options, NOW);
    expect(drafts).toContain('STATUS:TENTATIVE');

    const failed = generateIcs(
      [post({ status: 'error', error: { message: 'Token expired', supportUrl: null } })],
      channels,
      options,
      NOW,
    );
    expect(failed).toContain('STATUS:TENTATIVE');
    expect(failed).toContain('SUMMARY:⚠️ ');
    expect(unfold(failed)).toContain('Error: Token expired');
  });

  it('marks scheduled and sent posts CONFIRMED', () => {
    for (const status of ['scheduled', 'sent'] as const) {
      expect(generateIcs([post({ status })], channels, options, NOW)).toContain('STATUS:CONFIRMED');
    }
  });

  it('places sent posts by sentAt when dueAt is absent', () => {
    const ics = generateIcs(
      [post({ status: 'sent', dueAt: null, sentAt: '2026-07-01T09:30:00.000Z' })],
      channels,
      options,
      NOW,
    );

    expect(ics).toContain('DTSTART:20260701T093000Z');
  });

  it('skips posts with no schedule at all', () => {
    const ics = generateIcs([post({ dueAt: null, sentAt: null })], channels, options, NOW);

    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('skips posts with an unparseable date rather than emitting Invalid Date', () => {
    const ics = generateIcs([post({ dueAt: 'not-a-date' })], channels, options, NOW);

    expect(ics).not.toContain('BEGIN:VEVENT');
    expect(ics).not.toContain('NaN');
  });

  it('lists the service and tags as categories', () => {
    const ics = generateIcs(
      [post({ tags: [{ id: 't1', name: 'Unstream' }, { id: 't2', name: 'launch' }] })],
      channels,
      options,
      NOW,
    );

    expect(ics).toContain('CATEGORIES:Threads,Unstream,launch');
  });

  it('degrades gracefully when a channel cannot be resolved', () => {
    const ics = generateIcs([post({ channelId: 'ch_gone', channel: null })], channels, options, NOW);

    expect(ics).toContain('BEGIN:VEVENT');
    expect(unfold(ics)).toContain('Channel: (unknown)');
  });
});

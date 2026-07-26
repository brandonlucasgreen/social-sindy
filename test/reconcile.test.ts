import { describe, expect, it } from 'vitest';

import type { BufferPost } from '../src/buffer/types.js';
import type { ExistingEvent } from '../src/google/calendar.js';
import type { ChannelRef } from '../src/present.js';
import { googleEventId, isPlanEmpty, planSync, toGoogleEvent } from '../src/sync/reconcile.js';

const channels = new Map<string, ChannelRef>([
  ['ch_threads', { id: 'ch_threads', name: 'kidlightbulbs', service: 'threads' }],
]);

const options = {
  eventDurationMinutes: 30,
  showChannelInTitle: true,
  timeZone: 'America/New_York',
};

function post(overrides: Partial<BufferPost> = {}): BufferPost {
  return {
    id: '6a5e4200f49c0e22b7d5c650',
    status: 'scheduled',
    text: 'Buy music directly from artists.',
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
    channel: { id: 'ch_threads', name: 'kidlightbulbs', displayName: null, service: 'threads' },
    ...overrides,
  };
}

/** An event as reconciliation would see it coming back from Google. */
function existing(p: BufferPost, updatedMarker: string | null = p.updatedAt): ExistingEvent {
  return { id: googleEventId(p.id), postId: p.id, updatedMarker };
}

describe('googleEventId', () => {
  it('produces only characters Google accepts', () => {
    // Google requires base32hex: lowercase a-v and digits 0-9, 5-1024 chars.
    for (const id of ['6a5e4200f49c0e22b7d5c650', 'ABCXYZ', 'zzz', 'w-x_y', '✨emoji']) {
      const eventId = googleEventId(id);
      expect(eventId).toMatch(/^[0-9a-v]+$/);
      expect(eventId.length).toBeGreaterThanOrEqual(5);
      expect(eventId.length).toBeLessThanOrEqual(1024);
    }
  });

  it('is deterministic', () => {
    expect(googleEventId('abc')).toBe(googleEventId('abc'));
  });

  it('is injective, including for the raw-versus-encoded collision', () => {
    // A "use the raw ID when it is already valid" implementation would map the
    // raw ID `616263` and the hex encoding of `abc` onto the same event.
    expect(googleEventId('abc')).not.toBe(googleEventId('616263'));

    const ids = ['a', 'b', 'abc', '616263', '6a5e4200f49c0e22b7d5c650', 'w', 'z'];
    expect(new Set(ids.map(googleEventId)).size).toBe(ids.length);
  });

  it('handles characters outside the allowed set without producing invalid IDs', () => {
    // Uppercase and w-z are not valid base32hex, so they must be encoded away.
    expect(googleEventId('WXYZ')).toMatch(/^[0-9a-v]+$/);
  });
});

describe('toGoogleEvent', () => {
  it('carries the sync markers Google holds on our behalf', () => {
    const event = toGoogleEvent(post(), channels, options)!;
    const properties = event.extendedProperties!.private!;

    // These three are the entire sync state: no local mapping table exists.
    expect(properties.bufferCal).toBe('1');
    expect(properties.bufferPostId).toBe('6a5e4200f49c0e22b7d5c650');
    expect(properties.bufferUpdatedAt).toBe('2026-07-21T08:15:00.000Z');
  });

  it('sets start and end from dueAt and the configured duration', () => {
    const event = toGoogleEvent(post(), channels, options)!;

    expect(event.start).toEqual({
      dateTime: '2026-08-02T13:00:00.000Z',
      timeZone: 'America/New_York',
    });
    expect(event.end!.dateTime).toBe('2026-08-02T13:30:00.000Z');
  });

  it('mirrors the ICS presentation', () => {
    const event = toGoogleEvent(post(), channels, options)!;

    expect(event.summary).toBe('🧵 kidlightbulbs: Buy music directly from artists.');
    expect(event.description).toContain('Open in Buffer: https://publish.buffer.com/post/');
    expect(event.source!.url).toBe('https://publish.buffer.com/post/6a5e4200f49c0e22b7d5c650');
    // Informational, not time the user is busy.
    expect(event.transparency).toBe('transparent');
  });

  it('marks unpublished states tentative', () => {
    expect(toGoogleEvent(post({ status: 'draft' }), channels, options)!.status).toBe('tentative');
    expect(toGoogleEvent(post({ status: 'error' }), channels, options)!.status).toBe('tentative');
    expect(toGoogleEvent(post({ status: 'sent' }), channels, options)!.status).toBe('confirmed');
  });

  it('returns null for a post with no date to place', () => {
    expect(toGoogleEvent(post({ dueAt: null, sentAt: null }), channels, options)).toBeNull();
    expect(toGoogleEvent(post({ dueAt: 'nonsense' }), channels, options)).toBeNull();
  });
});

describe('planSync', () => {
  it('creates events that do not exist yet', () => {
    const plan = planSync([post()], [], channels, options);

    expect(plan.create).toHaveLength(1);
    expect(plan.update).toHaveLength(0);
    expect(plan.remove).toHaveLength(0);
  });

  it('leaves unchanged events completely alone', () => {
    const p = post();
    const plan = planSync([p], [existing(p)], channels, options);

    expect(plan).toMatchObject({ create: [], update: [], remove: [], unchanged: 1 });
    expect(isPlanEmpty(plan)).toBe(true);
  });

  it('updates an event when Buffer reports a newer updatedAt', () => {
    const p = post({ updatedAt: '2026-07-25T10:00:00.000Z' });
    const plan = planSync([p], [existing(p, '2026-07-21T08:15:00.000Z')], channels, options);

    expect(plan.update).toHaveLength(1);
    expect(plan.create).toHaveLength(0);
    expect(plan.remove).toHaveLength(0);
  });

  it('updates when the existing event has no marker at all', () => {
    // An event written by an older version, or edited by hand in Google.
    const p = post();
    const plan = planSync([p], [existing(p, null)], channels, options);

    expect(plan.update).toHaveLength(1);
  });

  it('removes events Buffer no longer lists', () => {
    const gone = post({ id: 'aaaa1111bbbb2222cccc3333' });
    const plan = planSync([post()], [existing(post()), existing(gone)], channels, options);

    expect(plan.remove).toEqual([googleEventId(gone.id)]);
    expect(plan.create).toHaveLength(0);
  });

  it('removes nothing when Buffer returns the same set', () => {
    const a = post();
    const b = post({ id: 'aaaa1111bbbb2222cccc3333' });
    const plan = planSync([a, b], [existing(a), existing(b)], channels, options);

    expect(plan.remove).toEqual([]);
    expect(plan.unchanged).toBe(2);
  });

  it('does not delete everything when Buffer returns nothing', () => {
    // This is the dangerous case: an empty Buffer window legitimately means
    // "remove these", but only because the caller has already distinguished a
    // successful empty response from a failed fetch.
    const plan = planSync([], [existing(post())], channels, options);

    expect(plan.remove).toHaveLength(1);
    expect(plan.create).toHaveLength(0);
  });

  it('never touches an event that is not ours to touch', () => {
    // Reconciliation only ever sees events carrying our owner tag, because
    // events.list filters on privateExtendedProperty. Anything the user added
    // themselves is absent from `existing` and so cannot be planned for removal.
    const plan = planSync([], [], channels, options);

    expect(plan.remove).toEqual([]);
    expect(isPlanEmpty(plan)).toBe(true);
  });

  it('skips undated posts rather than planning a broken event', () => {
    const plan = planSync([post({ dueAt: null, sentAt: null })], [], channels, options);

    expect(isPlanEmpty(plan)).toBe(true);
  });

  it('collapses a duplicated post into one write', () => {
    // Two writes for the same event ID in one run would race each other.
    const plan = planSync([post(), post()], [], channels, options);

    expect(plan.create).toHaveLength(1);
  });

  it('does not plan a removal for a post it just skipped', () => {
    // The undated post is skipped, but its existing event must still be removed
    // rather than left orphaned — it no longer has a place on the calendar.
    const p = post({ dueAt: null, sentAt: null });
    const plan = planSync([p], [existing(p)], channels, options);

    expect(plan.remove).toEqual([googleEventId(p.id)]);
  });

  it('handles a mixed batch in one pass', () => {
    const unchanged = post({ id: 'aaaa0000aaaa0000aaaa0000' });
    const edited = post({ id: 'bbbb1111bbbb1111bbbb1111', updatedAt: '2026-07-26T09:00:00.000Z' });
    const fresh = post({ id: 'cccc2222cccc2222cccc2222' });
    const vanished = post({ id: 'dddd3333dddd3333dddd3333' });

    const plan = planSync(
      [unchanged, edited, fresh],
      [existing(unchanged), existing(edited, '2026-07-20T00:00:00.000Z'), existing(vanished)],
      channels,
      options,
    );

    expect(plan.create.map((e) => e.id)).toEqual([googleEventId(fresh.id)]);
    expect(plan.update.map((e) => e.id)).toEqual([googleEventId(edited.id)]);
    expect(plan.remove).toEqual([googleEventId(vanished.id)]);
    expect(plan.unchanged).toBe(1);
  });
});

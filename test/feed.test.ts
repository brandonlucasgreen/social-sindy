import { describe, expect, it, vi } from 'vitest';

import { BufferRateLimitError } from '../src/buffer/client.js';
import { cachedFeed, etagFor, respondWithFeed } from '../src/feed.js';
import type { CalendarWithChannels } from '../src/db.js';
import type { Env } from '../src/env.js';

/** In-memory stand-in for a KV namespace, with TTL recorded rather than enforced. */
function fakeKv() {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    store,
    namespace: {
      get: vi.fn(async (key: string, type?: string) => {
        const hit = store.get(key);
        if (!hit) return null;
        return type === 'json' ? JSON.parse(hit.value) : hit.value;
      }),
      put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
        store.set(key, { value, ttl: options?.expirationTtl });
      }),
      delete: vi.fn(async (key: string) => void store.delete(key)),
    } as unknown as KVNamespace,
  };
}

/** Minimal D1 stand-in; the feed only ever writes poll bookkeeping through it. */
function fakeDb(): D1Database {
  const statement = {
    bind: () => statement,
    run: async () => ({ success: true }),
    first: async () => null,
    all: async () => ({ results: [] }),
  };
  return { prepare: () => statement, batch: async () => [] } as unknown as D1Database;
}

function calendar(overrides: Partial<CalendarWithChannels> = {}): CalendarWithChannels {
  return {
    id: 'cal_1',
    user_id: 'usr_1',
    organization_id: 'org_1',
    organization_name: 'Cult of Lightbulbs',
    name: 'Buffer — Cult of Lightbulbs',
    feed_token: 'tok',
    event_duration_minutes: 15,
    refresh_minutes: 60,
    window_past_days: 30,
    window_future_days: 90,
    statuses: 'scheduled,sent',
    show_channel_in_title: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    last_polled_at: null,
    last_fetched_at: null,
    last_event_count: null,
    last_error: null,
    google_calendar_id: null,
    push_enabled: 0,
    last_push_at: null,
    last_push_error: null,
    last_push_stats: null,
    channels: [
      { calendar_id: 'cal_1', channel_id: 'ch_a', channel_name: 'kidlightbulbs', service: 'threads' },
    ],
    ...overrides,
  };
}

function env(kv: KVNamespace): Env {
  return {
    DB: fakeDb(),
    FEED_CACHE: kv,
    APP_BASE_URL: 'https://example.com',
    ENCRYPTION_KEY: 'unused-in-these-tests',
  };
}

const ICS_A = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const ICS_B = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

describe('cachedFeed', () => {
  it('renders and caches on a cold start', async () => {
    const kv = fakeKv();
    const render = vi.fn(async () => ICS_A);

    const result = await cachedFeed(env(kv.namespace), calendar(), render);

    expect(result).toMatchObject({ body: ICS_A, cached: false, stale: false, eventCount: 1 });
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('serves cache without contacting Buffer, however often it is polled', async () => {
    // This is the property that stops a public URL from draining a user's quota.
    const kv = fakeKv();
    const render = vi.fn(async () => ICS_A);
    const cal = calendar();

    await cachedFeed(env(kv.namespace), cal, render);
    for (let i = 0; i < 25; i++) await cachedFeed(env(kv.namespace), cal, render);

    expect(render).toHaveBeenCalledTimes(1);
  });

  it('caches for the calendar\'s refresh interval', async () => {
    const kv = fakeKv();
    await cachedFeed(env(kv.namespace), calendar({ refresh_minutes: 360 }), async () => ICS_A);

    expect(kv.store.get('feed:fresh:cal_1:2026-07-01T00:00:00.000Z')?.ttl).toBe(360 * 60);
  });

  it('never sets a TTL below the KV minimum', async () => {
    const kv = fakeKv();
    await cachedFeed(env(kv.namespace), calendar({ refresh_minutes: 0 }), async () => ICS_A);

    expect(kv.store.get('feed:fresh:cal_1:2026-07-01T00:00:00.000Z')?.ttl).toBe(60);
  });

  it('invalidates the cache when calendar settings change', async () => {
    // updated_at is part of the cache key, so an edit takes effect immediately
    // rather than after the refresh interval elapses.
    const kv = fakeKv();
    const render = vi.fn(async () => ICS_A);

    await cachedFeed(env(kv.namespace), calendar(), render);
    await cachedFeed(
      env(kv.namespace),
      calendar({ updated_at: '2026-07-02T00:00:00.000Z' }),
      render,
    );

    expect(render).toHaveBeenCalledTimes(2);
  });

  it('serves the last good render when Buffer fails', async () => {
    const kv = fakeKv();
    const cal = calendar();
    await cachedFeed(env(kv.namespace), cal, async () => ICS_A);

    // Expire the fresh entry, leaving only the long-lived fallback.
    kv.store.delete('feed:fresh:cal_1:2026-07-01T00:00:00.000Z');

    const result = await cachedFeed(env(kv.namespace), cal, async () => {
      throw new Error('Buffer is down');
    });

    expect(result).toMatchObject({ body: ICS_A, stale: true, cached: true });
  });

  it('backs off using Retry-After when rate limited', async () => {
    const kv = fakeKv();
    const cal = calendar();
    await cachedFeed(env(kv.namespace), cal, async () => ICS_A);
    kv.store.delete('feed:fresh:cal_1:2026-07-01T00:00:00.000Z');

    await cachedFeed(env(kv.namespace), cal, async () => {
      throw new BufferRateLimitError(900, []);
    });

    expect(kv.store.get('feed:fresh:cal_1:2026-07-01T00:00:00.000Z')?.ttl).toBe(900);
  });

  it('propagates the failure when there is no previous render to fall back on', async () => {
    const kv = fakeKv();

    await expect(
      cachedFeed(env(kv.namespace), calendar(), async () => {
        throw new Error('Buffer is down');
      }),
    ).rejects.toThrow('Buffer is down');
  });

  it('keeps the fallback alive across a later successful render', async () => {
    const kv = fakeKv();
    const cal = calendar();

    await cachedFeed(env(kv.namespace), cal, async () => ICS_A);
    kv.store.delete('feed:fresh:cal_1:2026-07-01T00:00:00.000Z');
    await cachedFeed(env(kv.namespace), cal, async () => ICS_B);

    expect(kv.store.get('feed:last-good:cal_1')?.value).toBe(ICS_B);
    expect(kv.store.get('feed:last-good:cal_1')?.ttl).toBe(7 * 86_400);
  });
});

describe('etagFor', () => {
  it('is stable for identical content and differs otherwise', async () => {
    expect(await etagFor(ICS_A)).toBe(await etagFor(ICS_A));
    expect(await etagFor(ICS_A)).not.toBe(await etagFor(ICS_B));
  });

  it('is a weak validator', async () => {
    expect(await etagFor(ICS_A)).toMatch(/^W\/"[0-9a-f]{24}"$/);
  });
});

describe('respondWithFeed', () => {
  const url = 'https://example.com/feed/tok.ics';

  it('serves the calendar with the right content type and cache headers', async () => {
    const kv = fakeKv();
    await kv.namespace.put('feed:fresh:cal_1:2026-07-01T00:00:00.000Z', ICS_A);

    const response = await respondWithFeed(
      env(kv.namespace),
      calendar(),
      new Request(url),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(await response.text()).toBe(ICS_A);
  });

  it('answers 304 when the client already has this version', async () => {
    const kv = fakeKv();
    await kv.namespace.put('feed:fresh:cal_1:2026-07-01T00:00:00.000Z', ICS_A);
    const etag = await etagFor(ICS_A);

    const response = await respondWithFeed(
      env(kv.namespace),
      calendar(),
      new Request(url, { headers: { 'If-None-Match': etag } }),
    );

    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
  });

  it('omits the body for HEAD but keeps the headers', async () => {
    const kv = fakeKv();
    await kv.namespace.put('feed:fresh:cal_1:2026-07-01T00:00:00.000Z', ICS_A);

    const response = await respondWithFeed(
      env(kv.namespace),
      calendar(),
      new Request(url, { method: 'HEAD' }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('ETag')).toBeTruthy();
  });

  it('flags a stale render so the problem is visible', async () => {
    const kv = fakeKv();
    await kv.namespace.put('feed:last-good:cal_1', ICS_A);

    // No stored credential, so the render fails and the fallback is used.
    const response = await respondWithFeed(env(kv.namespace), calendar(), new Request(url));

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Feed-Stale')).toBe('true');
  });

  it('returns 503 with Retry-After rather than 401 when it cannot build', async () => {
    // A 401 would make calendar clients prompt for credentials they cannot send.
    const kv = fakeKv();

    const response = await respondWithFeed(env(kv.namespace), calendar(), new Request(url));

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBeTruthy();
  });
});

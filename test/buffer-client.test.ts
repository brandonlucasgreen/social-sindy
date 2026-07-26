import { describe, expect, it, vi } from 'vitest';

import {
  BufferApiError,
  BufferAuthError,
  BufferClient,
  BufferRateLimitError,
  lowestRemaining,
  parseRateLimit,
} from '../src/buffer/client.js';

describe('parseRateLimit', () => {
  it('parses a single window', () => {
    expect(parseRateLimit('"200-in-15min";r=198;t=897')).toEqual([
      { policy: '200-in-15min', remaining: 198, resetSeconds: 897 },
    ]);
  });

  it('parses every window when fetch joins repeated headers with commas', () => {
    // The joined value contains commas, so a naive `split(',')` would shred it.
    const joined = '"100-in-15min";r=98;t=897, "250-in-24h";r=201;t=41000, "3000-in-30d";r=2755;t=2000000';

    expect(parseRateLimit(joined)).toEqual([
      { policy: '100-in-15min', remaining: 98, resetSeconds: 897 },
      { policy: '250-in-24h', remaining: 201, resetSeconds: 41000 },
      { policy: '3000-in-30d', remaining: 2755, resetSeconds: 2000000 },
    ]);
  });

  it('tolerates whitespace variations', () => {
    expect(parseRateLimit('"250-in-24h" ; r=5 ; t=60')).toEqual([
      { policy: '250-in-24h', remaining: 5, resetSeconds: 60 },
    ]);
  });

  it('returns empty for a missing or unparseable header', () => {
    expect(parseRateLimit(null)).toEqual([]);
    expect(parseRateLimit('')).toEqual([]);
    expect(parseRateLimit('garbage')).toEqual([]);
  });
});

describe('lowestRemaining', () => {
  it('reports the tightest window, which is what actually blocks us', () => {
    const windows = parseRateLimit('"100-in-15min";r=98;t=897, "250-in-24h";r=3;t=41000');
    expect(lowestRemaining(windows)).toBe(3);
  });

  it('returns null when no windows were reported', () => {
    expect(lowestRemaining([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

const ACCOUNT_BODY = {
  data: {
    account: {
      id: 'acct_1',
      email: 'brandon@buffer.com',
      name: 'Brandon Lucas Green',
      timezone: 'America/New_York',
      organizations: [{ id: 'org_1', name: 'Cult of Lightbulbs', ownerEmail: 'brandon@buffer.com' }],
    },
  },
};

describe('BufferClient', () => {
  it('sends the API key as a bearer token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ACCOUNT_BODY));
    await new BufferClient('secret-key', fetchImpl as unknown as typeof fetch).getAccount();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.buffer.com');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
  });

  it('returns the account and the parsed quota together', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(ACCOUNT_BODY, { headers: { RateLimit: '"250-in-24h";r=249;t=86000' } }),
    );

    const result = await new BufferClient('k', fetchImpl as unknown as typeof fetch).getAccount();

    expect(result.data.email).toBe('brandon@buffer.com');
    expect(result.rateLimit).toEqual([{ policy: '250-in-24h', remaining: 249, resetSeconds: 86000 }]);
  });

  it('raises BufferAuthError on 401 so the stored key can be marked dead', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));

    await expect(
      new BufferClient('bad', fetchImpl as unknown as typeof fetch).getAccount(),
    ).rejects.toBeInstanceOf(BufferAuthError);
  });

  it('re-classifies GraphQL-level auth failures as BufferAuthError', async () => {
    // Some operations return 200 with the failure in the errors array.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ message: 'Unauthorized: invalid token' }] }),
    );

    await expect(
      new BufferClient('bad', fetchImpl as unknown as typeof fetch).getAccount(),
    ).rejects.toBeInstanceOf(BufferAuthError);
  });

  it('surfaces Retry-After on 429', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('slow down', {
          status: 429,
          headers: { 'Retry-After': '120', RateLimit: '"100-in-15min";r=0;t=300' },
        }),
    );

    const error = await new BufferClient('k', fetchImpl as unknown as typeof fetch)
      .getAccount()
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BufferRateLimitError);
    expect((error as BufferRateLimitError).retryAfterSeconds).toBe(120);
    expect(lowestRemaining((error as BufferRateLimitError).windows)).toBe(0);
  });

  it('reports other GraphQL errors as BufferApiError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: 'Query too complex' }] }));

    await expect(
      new BufferClient('k', fetchImpl as unknown as typeof fetch).getAccount(),
    ).rejects.toThrow(/Query too complex/);
  });

  it('wraps network failures rather than leaking them', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down');
    });

    await expect(
      new BufferClient('k', fetchImpl as unknown as typeof fetch).getAccount(),
    ).rejects.toBeInstanceOf(BufferApiError);
  });

  it('filters posts to the window and selected channels server-side', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { posts: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
    );

    await new BufferClient('k', fetchImpl as unknown as typeof fetch).fetchPosts({
      organizationId: 'org_1',
      channelIds: ['ch_a', 'ch_b'],
      statuses: ['scheduled', 'sent'],
      start: new Date('2026-07-01T00:00:00.000Z'),
      end: new Date('2026-10-01T00:00:00.000Z'),
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.variables.input.filter).toEqual({
      channelIds: ['ch_a', 'ch_b'],
      status: ['scheduled', 'sent'],
      dueAt: { start: '2026-07-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
    });
    expect(body.variables.input.sort).toEqual([{ field: 'dueAt', direction: 'asc' }]);
  });

  it('follows pagination cursors and accumulates every page', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      const last = call === 3;
      return jsonResponse({
        data: {
          posts: {
            edges: [{ node: { id: `post_${call}` } }],
            pageInfo: { hasNextPage: !last, endCursor: last ? null : `cursor_${call}` },
          },
        },
      });
    });

    const result = await new BufferClient('k', fetchImpl as unknown as typeof fetch).fetchPosts({
      organizationId: 'org_1',
      channelIds: ['ch_a'],
      statuses: ['scheduled'],
      start: new Date('2026-07-01T00:00:00.000Z'),
      end: new Date('2026-10-01T00:00:00.000Z'),
    });

    expect(result.posts.map((p) => p.id)).toEqual(['post_1', 'post_2', 'post_3']);
    expect(result.truncated).toBe(false);

    const secondCall = JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(secondCall.variables.after).toBe('cursor_1');
  });

  it('stops at the page cap and flags truncation instead of draining the quota', async () => {
    // A never-ending queue must not spend an entire 24-hour budget in one poll.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          posts: {
            edges: [{ node: { id: 'post' } }],
            pageInfo: { hasNextPage: true, endCursor: 'more' },
          },
        },
      }),
    );

    const result = await new BufferClient('k', fetchImpl as unknown as typeof fetch).fetchPosts({
      organizationId: 'org_1',
      channelIds: ['ch_a'],
      statuses: ['scheduled'],
      start: new Date('2026-07-01T00:00:00.000Z'),
      end: new Date('2026-10-01T00:00:00.000Z'),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(result.truncated).toBe(true);
  });

  it('tolerates a null edges array', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { posts: { edges: null, pageInfo: { hasNextPage: false, endCursor: null } } } }),
    );

    const result = await new BufferClient('k', fetchImpl as unknown as typeof fetch).fetchPosts({
      organizationId: 'org_1',
      channelIds: [],
      statuses: ['scheduled'],
      start: new Date('2026-07-01T00:00:00.000Z'),
      end: new Date('2026-10-01T00:00:00.000Z'),
    });

    expect(result.posts).toEqual([]);
  });
});

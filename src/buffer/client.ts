/**
 * Client for the Buffer GraphQL API (https://api.buffer.com).
 *
 * Buffer's quotas are the binding constraint on this whole product: as few as
 * 100 requests per 15 minutes, 250 per 24 hours, and 3,000 per 30 days on the
 * lower plans, scoped per credential. Every method here is written to spend as
 * few requests as possible, and every response's remaining quota is surfaced so
 * callers can back off before they get cut off.
 */

import type {
  BufferAccount,
  BufferChannel,
  BufferPost,
  PostStatus,
  RateLimitWindow,
} from './types.js';

const API_URL = 'https://api.buffer.com';

/** Buffer rejected the credential. The stored key should be treated as dead. */
export class BufferAuthError extends Error {
  constructor(message = 'Buffer rejected this API key') {
    super(message);
    this.name = 'BufferAuthError';
  }
}

/** Quota exhausted. `retryAfterSeconds` comes from Buffer's Retry-After header. */
export class BufferRateLimitError extends Error {
  constructor(
    readonly retryAfterSeconds: number | null,
    readonly windows: RateLimitWindow[],
  ) {
    super('Buffer API rate limit reached');
    this.name = 'BufferRateLimitError';
  }
}

export class BufferApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BufferApiError';
  }
}

/**
 * Parses Buffer's `RateLimit` headers.
 *
 * Buffer sends one header per rolling window; `fetch` joins repeated headers
 * with commas, so this matches globally rather than splitting on a delimiter
 * that also appears inside the joined value.
 */
export function parseRateLimit(headerValue: string | null): RateLimitWindow[] {
  if (!headerValue) return [];
  const windows: RateLimitWindow[] = [];
  const pattern = /"([^"]+)"\s*;\s*r=(\d+)\s*;\s*t=(\d+)/g;

  for (const match of headerValue.matchAll(pattern)) {
    windows.push({
      policy: match[1]!,
      remaining: Number(match[2]),
      resetSeconds: Number(match[3]),
    });
  }
  return windows;
}

/** The tightest remaining quota across all reported windows. */
export function lowestRemaining(windows: RateLimitWindow[]): number | null {
  if (!windows.length) return null;
  return Math.min(...windows.map((w) => w.remaining));
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export interface RequestResult<T> {
  data: T;
  rateLimit: RateLimitWindow[];
}

const CHANNEL_FIELDS = `
  id
  name
  displayName
  service
  type
  avatar
  isDisconnected
  isLocked
`;

const POST_FIELDS = `
  id
  status
  text
  dueAt
  sentAt
  createdAt
  updatedAt
  channelId
  channelService
  shareMode
  externalLink
  tags { id name }
  error { message supportUrl }
  assets { type mimeType source thumbnail }
  channel { id name displayName service }
`;

const ACCOUNT_QUERY = `
  query Account {
    account {
      id
      email
      name
      timezone
      organizations { id name ownerEmail }
    }
  }
`;

const CHANNELS_QUERY = `
  query Channels($input: ChannelsInput!) {
    channels(input: $input) { ${CHANNEL_FIELDS} }
  }
`;

const POSTS_QUERY = `
  query FeedPosts($input: PostsInput!, $first: Int!, $after: String) {
    posts(input: $input, first: $first, after: $after) {
      edges { node { ${POST_FIELDS} } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Buffer's maximum accepted page size for the posts connection. */
const PAGE_SIZE = 100;

/**
 * Cap on pages fetched per feed refresh. Each page is a separate request against
 * a 24-hour budget that can be as low as 250, so an unbounded loop over a large
 * queue could exhaust a user's quota in a single poll.
 */
const MAX_PAGES = 10;

export interface FetchPostsParams {
  organizationId: string;
  channelIds: string[];
  statuses: PostStatus[];
  /** Inclusive start of the dueAt window. */
  start: Date;
  /** Inclusive end of the dueAt window. */
  end: Date;
}

export interface FetchPostsResult {
  posts: BufferPost[];
  rateLimit: RateLimitWindow[];
  /** True when the page cap stopped us before the queue was exhausted. */
  truncated: boolean;
}

interface PostsPage {
  posts: {
    edges: { node: BufferPost }[] | null;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export class BufferClient {
  constructor(
    private readonly apiKey: string,
    /**
     * Injectable for tests. Bound to `globalThis` because it is then called as
     * `this.fetchImpl(...)`, which would otherwise invoke the global `fetch`
     * with a BufferClient as its receiver — workerd rejects that outright with
     * "Illegal invocation: function called with incorrect `this` reference".
     *
     * Node's fetch is lenient about the receiver, so this fails only on
     * Cloudflare and never in the test suite. Do not "simplify" the bind away.
     */
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
    operationName: string,
  ): Promise<RequestResult<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables, operationName }),
      });
    } catch (cause) {
      throw new BufferApiError(`Could not reach the Buffer API: ${String(cause)}`);
    }

    const rateLimit = parseRateLimit(response.headers.get('RateLimit'));

    if (response.status === 401 || response.status === 403) {
      throw new BufferAuthError();
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      throw new BufferRateLimitError(Number.isFinite(retryAfter) ? retryAfter : null, rateLimit);
    }
    if (!response.ok) {
      throw new BufferApiError(
        `Buffer API returned ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    let body: GraphQLResponse<T>;
    try {
      body = (await response.json()) as GraphQLResponse<T>;
    } catch {
      throw new BufferApiError('Buffer API returned a malformed response');
    }

    if (body.errors?.length) {
      // GraphQL surfaces auth failures in the error body rather than the status
      // on some operations, so re-classify those to keep callers' handling simple.
      const message = body.errors.map((e) => e.message).join('; ');
      if (/unauthor|forbidden|invalid.*(key|token)/i.test(message)) {
        throw new BufferAuthError(message);
      }
      throw new BufferApiError(message);
    }
    if (!body.data) throw new BufferApiError('Buffer API returned no data');

    return { data: body.data, rateLimit };
  }

  /** Fetches the signed-in account. Doubles as validation of a pasted API key. */
  async getAccount(): Promise<RequestResult<BufferAccount>> {
    const result = await this.request<{ account: BufferAccount }>(ACCOUNT_QUERY, {}, 'Account');
    return { data: result.data.account, rateLimit: result.rateLimit };
  }

  async getChannels(organizationId: string): Promise<RequestResult<BufferChannel[]>> {
    const result = await this.request<{ channels: BufferChannel[] }>(
      CHANNELS_QUERY,
      { input: { organizationId } },
      'Channels',
    );
    return { data: result.data.channels, rateLimit: result.rateLimit };
  }

  /**
   * Fetches posts for the feed window.
   *
   * Filters on `dueAt`, so unscheduled drafts are excluded server-side rather
   * than fetched and discarded. Note this also excludes any sent post that has
   * no `dueAt` recorded.
   */
  async fetchPosts(params: FetchPostsParams): Promise<FetchPostsResult> {
    const input = {
      organizationId: params.organizationId,
      filter: {
        channelIds: params.channelIds,
        status: params.statuses,
        dueAt: { start: params.start.toISOString(), end: params.end.toISOString() },
      },
      sort: [{ field: 'dueAt', direction: 'asc' }],
    };

    const posts: BufferPost[] = [];
    let rateLimit: RateLimitWindow[] = [];
    let after: string | null = null;
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      // Annotated rather than inferred: `after` is reassigned from this result
      // below, and inference would treat that as a circular reference.
      const result: RequestResult<PostsPage> = await this.request<PostsPage>(
        POSTS_QUERY,
        { input, first: PAGE_SIZE, after },
        'FeedPosts',
      );

      rateLimit = result.rateLimit;
      for (const edge of result.data.posts.edges ?? []) posts.push(edge.node);

      const { hasNextPage, endCursor } = result.data.posts.pageInfo;
      if (!hasNextPage || !endCursor) break;
      after = endCursor;

      if (page === MAX_PAGES - 1) truncated = true;
    }

    return { posts, rateLimit, truncated };
  }
}

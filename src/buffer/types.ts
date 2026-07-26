/** Shapes returned by the Buffer GraphQL API (api.buffer.com). */

export const POST_STATUSES = [
  'draft',
  'needs_approval',
  'scheduled',
  'sending',
  'sent',
  'error',
] as const;

export type PostStatus = (typeof POST_STATUSES)[number];

export function isPostStatus(value: string): value is PostStatus {
  return (POST_STATUSES as readonly string[]).includes(value);
}

export interface BufferAsset {
  type: string | null;
  mimeType: string | null;
  source: string | null;
  thumbnail: string | null;
}

export interface BufferTag {
  id: string;
  name: string;
}

export interface BufferPublishingError {
  message: string;
  supportUrl: string | null;
}

export interface BufferPost {
  id: string;
  status: PostStatus;
  text: string;
  /** Scheduled publish instant, ISO-8601 UTC. Null for unscheduled drafts. */
  dueAt: string | null;
  sentAt: string | null;
  createdAt: string;
  /** Drives LAST-MODIFIED, so clients can tell a real edit from a re-poll. */
  updatedAt: string;
  channelId: string;
  channelService: string;
  shareMode: string | null;
  tags: BufferTag[];
  error: BufferPublishingError | null;
  assets: BufferAsset[];
  /**
   * Resolved inline by the feed query. Fetching the channel with the post costs
   * a little query complexity but saves a whole request against the rate limit.
   */
  channel: Pick<BufferChannel, 'id' | 'name' | 'displayName' | 'service'> | null;
}

export interface BufferChannel {
  id: string;
  name: string;
  displayName: string | null;
  service: string;
  type: string | null;
  avatar: string | null;
  isDisconnected: boolean;
  isLocked: boolean;
}

export interface BufferOrganization {
  id: string;
  name: string;
  ownerEmail: string | null;
}

export interface BufferAccount {
  id: string;
  email: string;
  name: string | null;
  timezone: string | null;
  organizations: BufferOrganization[];
}

/**
 * Remaining quota parsed from a Buffer response, one entry per rolling window.
 *
 * Buffer's limits are tight enough to design around: 100 per 15 minutes and
 * as few as 250 per 24 hours / 3,000 per 30 days on the lower plans.
 */
export interface RateLimitWindow {
  /** Window label as reported by Buffer, e.g. `200-in-15min`. */
  policy: string;
  remaining: number;
  resetSeconds: number;
}

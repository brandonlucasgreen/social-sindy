/**
 * Google Calendar API v3 client, scoped to the calendars this app creates.
 *
 * Only the handful of operations push needs: create the dedicated calendar,
 * list our own events in a window, and insert/patch/delete them.
 */

const API_BASE = 'https://www.googleapis.com/calendar/v3';

/**
 * Marks every event this app writes. Used as an events.list filter so a
 * reconciliation pass can only ever see — and therefore only ever delete —
 * events it created itself.
 */
export const OWNER_TAG_KEY = 'bufferCal';
export const OWNER_TAG_VALUE = '1';

/** Holds Buffer's `updatedAt`, so a change can be detected without a local map. */
export const UPDATED_AT_KEY = 'bufferUpdatedAt';
export const POST_ID_KEY = 'bufferPostId';

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }

  /** Quota and rate-limit failures, which are worth retrying with backoff. */
  get isRateLimited(): boolean {
    return (
      this.status === 429 ||
      (this.status === 403 &&
        ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].includes(this.reason ?? ''))
    );
  }

  /** An event with this ID already exists, so the write should become a patch. */
  get isDuplicate(): boolean {
    return this.status === 409;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface GoogleEventTime {
  dateTime: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  status?: string;
  transparency?: string;
  source?: { title?: string; url?: string };
  extendedProperties?: { private?: Record<string, string> };
}

/** An existing event as seen during reconciliation. */
export interface ExistingEvent {
  id: string;
  postId: string | null;
  updatedMarker: string | null;
}

const MAX_ATTEMPTS = 4;

export class GoogleCalendarClient {
  constructor(
    private readonly accessToken: string,
    /**
     * Bound to `globalThis` for the same reason as in BufferClient: called as
     * `this.fetchImpl(...)`, an unbound global `fetch` gets this client as its
     * receiver and workerd throws "Illegal invocation". Node is lenient, so
     * the tests cannot catch it. Do not remove the bind.
     */
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    /** Injected so tests do not actually wait out the backoff. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<T | null> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let lastError: GoogleApiError | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter, as Google's error guide recommends.
        const base = 2 ** attempt * 250;
        await this.sleep(base + Math.floor(Math.random() * 250));
      }

      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        });
      } catch (cause) {
        lastError = new GoogleApiError(`Could not reach Google Calendar: ${String(cause)}`, 0);
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return null;
        const text = await response.text();
        return text ? (JSON.parse(text) as T) : null;
      }

      const error = await this.toError(response);

      // Retry only what is actually transient; surface everything else at once.
      if (error.isRateLimited || response.status >= 500) {
        lastError = error;
        continue;
      }
      throw error;
    }

    throw lastError ?? new GoogleApiError('Google Calendar request failed', 0);
  }

  private async toError(response: Response): Promise<GoogleApiError> {
    let reason: string | undefined;
    let message = `${response.status} ${response.statusText}`;

    try {
      const body = (await response.json()) as {
        error?: { message?: string; errors?: { reason?: string }[] };
      };
      reason = body.error?.errors?.[0]?.reason;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body; the status alone is enough to classify it.
    }

    return new GoogleApiError(message, response.status, reason);
  }

  /** Creates the dedicated secondary calendar and returns its ID. */
  async createCalendar(summary: string, timeZone: string): Promise<string> {
    const created = await this.request<{ id: string }>('POST', '/calendars', {
      body: { summary, description: 'Managed by social cally. Edits here will be overwritten.', timeZone },
    });

    if (!created?.id) throw new GoogleApiError('Google did not return a calendar ID', 0);
    return created.id;
  }

  async updateCalendarSummary(calendarId: string, summary: string): Promise<void> {
    await this.request('PATCH', `/calendars/${encodeURIComponent(calendarId)}`, {
      body: { summary },
    });
  }

  async deleteCalendar(calendarId: string): Promise<void> {
    try {
      await this.request('DELETE', `/calendars/${encodeURIComponent(calendarId)}`);
    } catch (error) {
      // Already gone is a success for our purposes.
      if (!(error instanceof GoogleApiError && error.isNotFound)) throw error;
    }
  }

  /**
   * Lists the events this app created in a window.
   *
   * Filtered by our private owner tag, so an event the user added to this
   * calendar themselves is invisible here and can never be deleted by a sync.
   */
  async listOwnEvents(
    calendarId: string,
    start: Date,
    end: Date,
  ): Promise<ExistingEvent[]> {
    const events: ExistingEvent[] = [];
    let pageToken: string | undefined;

    do {
      const page = await this.request<{
        items?: GoogleEvent[];
        nextPageToken?: string;
      }>('GET', `/calendars/${encodeURIComponent(calendarId)}/events`, {
        query: {
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          maxResults: '2500',
          singleEvents: 'true',
          showDeleted: 'false',
          privateExtendedProperty: `${OWNER_TAG_KEY}=${OWNER_TAG_VALUE}`,
          pageToken,
        },
      });

      for (const item of page?.items ?? []) {
        const properties = item.extendedProperties?.private ?? {};
        events.push({
          id: item.id,
          postId: properties[POST_ID_KEY] ?? null,
          updatedMarker: properties[UPDATED_AT_KEY] ?? null,
        });
      }

      pageToken = page?.nextPageToken;
    } while (pageToken);

    return events;
  }

  /**
   * Writes an event, treating a duplicate ID as an update.
   *
   * Google explicitly warns that ID collisions may not be detected at creation
   * time in a distributed system, so insert-then-patch is the reliable upsert.
   */
  async upsertEvent(calendarId: string, event: GoogleEvent): Promise<void> {
    try {
      await this.request('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, {
        body: event,
      });
    } catch (error) {
      if (error instanceof GoogleApiError && error.isDuplicate) {
        await this.patchEvent(calendarId, event);
        return;
      }
      throw error;
    }
  }

  async patchEvent(calendarId: string, event: GoogleEvent): Promise<void> {
    const { id, ...body } = event;
    await this.request(
      'PATCH',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`,
      { body },
    );
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.request(
        'DELETE',
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
    } catch (error) {
      // A concurrent delete is not a failure.
      if (!(error instanceof GoogleApiError && (error.isNotFound || error.status === 410))) {
        throw error;
      }
    }
  }
}

/**
 * Creating, viewing, and managing calendar feeds.
 */

import { Hono } from 'hono';
import type { FC } from 'hono/jsx';

import { BufferAuthError, BufferRateLimitError } from '../buffer/client.js';
import { isPostStatus, type BufferChannel, type PostStatus } from '../buffer/types.js';
import {
  createCalendar,
  deleteCalendar,
  getCalendar,
  listCalendars,
  parseStatuses,
  rotateFeedToken,
  updateCalendar,
  type CalendarWithChannels,
} from '../db.js';
import { serviceLabel } from '../ics/generate.js';
import { Layout, Notice } from '../ui/layout.jsx';
import {
  accountFor,
  channelsFor,
  requireUser,
  type AppBindings,
  type AppContext,
} from '../session.js';

export const calendarRoutes = new Hono<AppBindings>();

calendarRoutes.use('*', requireUser);

// -- form option sets -------------------------------------------------------

const DURATION_OPTIONS = [
  [15, '15 minutes'],
  [30, '30 minutes'],
  [60, '1 hour'],
] as const;

const REFRESH_OPTIONS = [
  [15, 'Every 15 minutes'],
  [60, 'Every hour'],
  [360, 'Every 6 hours'],
  [1440, 'Once a day'],
] as const;

const PAST_OPTIONS = [
  [0, 'Only upcoming posts'],
  [7, 'Past week'],
  [30, 'Past 30 days'],
  [90, 'Past 90 days'],
] as const;

const FUTURE_OPTIONS = [
  [30, 'Next 30 days'],
  [90, 'Next 90 days'],
  [180, 'Next 6 months'],
  [365, 'Next year'],
] as const;

const STATUS_OPTIONS: { value: PostStatus; label: string; hint: string }[] = [
  { value: 'scheduled', label: 'Scheduled', hint: 'Queued and ready to publish' },
  { value: 'sent', label: 'Published', hint: 'Keeps a history in your calendar' },
  { value: 'draft', label: 'Drafts', hint: 'Only those with a date set' },
  { value: 'needs_approval', label: 'Needs approval', hint: 'Awaiting review' },
  { value: 'error', label: 'Failed', hint: 'Flagged with a warning in the title' },
];

// -- form parsing -----------------------------------------------------------

type ParsedBody = Record<string, string | File | (string | File)[]>;

function toStrings(value: ParsedBody[string] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item): item is string => typeof item === 'string');
}

function toString(value: ParsedBody[string] | undefined): string {
  return toStrings(value)[0] ?? '';
}

/** Coerces a submitted number to one of the values we actually offer. */
function pickNumber(value: string, allowed: readonly number[], fallback: number): number {
  const parsed = Number(value);
  return allowed.includes(parsed) ? parsed : fallback;
}

interface CalendarSettings {
  name: string;
  channelIds: string[];
  eventDurationMinutes: number;
  refreshMinutes: number;
  windowPastDays: number;
  windowFutureDays: number;
  statuses: PostStatus[];
  showChannelInTitle: boolean;
}

function readSettings(body: ParsedBody, fallbackName: string): CalendarSettings {
  const statuses = toStrings(body['statuses']).filter(isPostStatus);

  return {
    name: toString(body['name']).trim().slice(0, 120) || fallbackName,
    channelIds: toStrings(body['channelIds']),
    eventDurationMinutes: pickNumber(
      toString(body['eventDurationMinutes']),
      DURATION_OPTIONS.map(([v]) => v),
      15,
    ),
    refreshMinutes: pickNumber(
      toString(body['refreshMinutes']),
      REFRESH_OPTIONS.map(([v]) => v),
      60,
    ),
    windowPastDays: pickNumber(toString(body['windowPastDays']), PAST_OPTIONS.map(([v]) => v), 30),
    windowFutureDays: pickNumber(
      toString(body['windowFutureDays']),
      FUTURE_OPTIONS.map(([v]) => v),
      90,
    ),
    statuses: statuses.length ? statuses : ['scheduled'],
    showChannelInTitle: toStrings(body['showChannelInTitle']).length > 0,
  };
}

// -- shared form pieces -----------------------------------------------------

const Select: FC<{
  name: string;
  label: string;
  hint?: string;
  options: readonly (readonly [number, string])[];
  value: number;
}> = ({ name, label, hint, options, value }) => (
  <div class="field">
    <label for={name}>{label}</label>
    <select id={name} name={name}>
      {options.map(([optionValue, optionLabel]) => (
        <option value={String(optionValue)} selected={optionValue === value}>
          {optionLabel}
        </option>
      ))}
    </select>
    {hint ? <small>{hint}</small> : null}
  </div>
);

const ChannelPicker: FC<{ channels: BufferChannel[]; selected: Set<string> }> = ({
  channels,
  selected,
}) => (
  <div class="channels">
    {channels.map((channel) => (
      <label class={channel.isDisconnected ? 'channel off' : 'channel'}>
        <input
          type="checkbox"
          name="channelIds"
          value={channel.id}
          checked={selected.has(channel.id)}
        />
        {channel.avatar ? <img src={channel.avatar} alt="" loading="lazy" /> : <span class="avatar" />}
        <span class="meta">
          <strong>{channel.displayName?.trim() || channel.name}</strong>
          <small>
            {serviceLabel(channel.service)}
            {channel.isDisconnected ? ' · disconnected in Buffer' : ''}
          </small>
        </span>
      </label>
    ))}
  </div>
);

const SettingsFields: FC<{ settings: CalendarSettings }> = ({ settings }) => (
  <>
    <div class="field">
      <label for="name">Calendar name</label>
      <input type="text" id="name" name="name" value={settings.name} maxlength={120} required />
      <small>Shown as the calendar's name in your calendar app.</small>
    </div>

    <h2>What to include</h2>
    {STATUS_OPTIONS.map((status) => (
      <div class="checkline">
        <input
          type="checkbox"
          id={`status-${status.value}`}
          name="statuses"
          value={status.value}
          checked={settings.statuses.includes(status.value)}
        />
        <label for={`status-${status.value}`}>
          {status.label} <small>— {status.hint}</small>
        </label>
      </div>
    ))}

    <div class="row" style="margin-top:18px">
      <Select
        name="windowPastDays"
        label="How far back"
        options={PAST_OPTIONS}
        value={settings.windowPastDays}
      />
      <Select
        name="windowFutureDays"
        label="How far ahead"
        options={FUTURE_OPTIONS}
        value={settings.windowFutureDays}
      />
    </div>

    <h2>How it looks</h2>
    <div class="row">
      <Select
        name="eventDurationMinutes"
        label="Event length"
        hint="Buffer posts are a single moment, so events get a fixed length."
        options={DURATION_OPTIONS}
        value={settings.eventDurationMinutes}
      />
      <Select
        name="refreshMinutes"
        label="Refresh interval"
        hint="Honoured by Apple Calendar. Google polls on its own schedule."
        options={REFRESH_OPTIONS}
        value={settings.refreshMinutes}
      />
    </div>

    <div class="checkline">
      <input
        type="checkbox"
        id="showChannelInTitle"
        name="showChannelInTitle"
        value="1"
        checked={settings.showChannelInTitle}
      />
      <label for="showChannelInTitle">
        Show the channel in the event title <small>— e.g. “🧵 kidlightbulbs: …”</small>
      </label>
    </div>
  </>
);

// -- dashboard --------------------------------------------------------------

function feedUrls(baseUrl: string, token: string) {
  const https = `${baseUrl.replace(/\/$/, '')}/feed/${token}.ics`;
  return {
    https,
    webcal: https.replace(/^https?:/, 'webcal:'),
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(https)}`,
  };
}

function syncState(calendar: CalendarWithChannels): { cls: string; text: string } {
  if (calendar.last_error) return { cls: 'bad', text: `Last refresh failed: ${calendar.last_error}` };
  if (!calendar.last_fetched_at) return { cls: 'stale', text: 'Not fetched yet' };

  const ageMinutes = Math.round((Date.now() - Date.parse(calendar.last_fetched_at)) / 60_000);
  const stale = ageMinutes > calendar.refresh_minutes * 3;
  const when =
    ageMinutes < 1 ? 'just now' : ageMinutes < 60 ? `${ageMinutes}m ago` : `${Math.round(ageMinutes / 60)}h ago`;

  return {
    cls: stale ? 'stale' : '',
    text: `Refreshed ${when}${calendar.last_event_count !== null ? ` · ${calendar.last_event_count} events` : ''}`,
  };
}

calendarRoutes.get('/calendars', async (c) => {
  const user = c.get('user')!;
  const calendars = await listCalendars(c.env.DB, user.id);

  return c.html(
    <Layout title="Your calendars — Buffer → Calendar" user={user}>
      <h1>Your calendars</h1>
      <p class="lede">Each calendar is one subscribable feed of your Buffer schedule.</p>

      {calendars.length === 0 ? (
        <div class="card">
          <div class="empty">
            <p>You have not created a calendar yet.</p>
            <a class="btn" href="/calendars/new">
              Create your first calendar
            </a>
          </div>
        </div>
      ) : (
        <>
          {calendars.map((calendar) => {
            const state = syncState(calendar);
            return (
              <div class="card">
                <div class="cal-item">
                  <div>
                    <h3>
                      <a href={`/calendars/${calendar.id}`}>{calendar.name}</a>
                    </h3>
                    <div class="tags">
                      {calendar.organization_name} · {calendar.channels.length}{' '}
                      {calendar.channels.length === 1 ? 'channel' : 'channels'}
                    </div>
                    <div class="tags">
                      <span class={`status-dot ${state.cls}`} />
                      {state.text}
                    </div>
                  </div>
                  <a class="btn btn-secondary" href={`/calendars/${calendar.id}`}>
                    Subscribe
                  </a>
                </div>
              </div>
            );
          })}
          <div class="btn-row">
            <a class="btn" href="/calendars/new">
              New calendar
            </a>
          </div>
        </>
      )}

      <h2>Account</h2>
      <div class="card">
        <p class="small">
          Signed in as {user.email}. Deleting your account removes your stored Buffer API key and
          every calendar you created here. It does not touch anything in Buffer.
        </p>
        <form
          method="post"
          action="/account/delete"
          onsubmit="return confirm('Delete your account, stored key, and all calendars? Existing feed URLs will stop working.')"
        >
          <button class="btn-danger" type="submit">
            Delete account and stored key
          </button>
        </form>
      </div>
    </Layout>,
  );
});

// -- create -----------------------------------------------------------------

/** Turns a Buffer or network failure into a page the user can act on. */
function bufferErrorPage(c: AppContext, error: unknown) {
  const user = c.get('user')!;
  const message =
    error instanceof BufferAuthError
      ? 'Buffer rejected your stored API key. It may have been revoked — reconnect to continue.'
      : error instanceof BufferRateLimitError
        ? "Buffer's API rate limit is exhausted for your key. Try again in a few minutes."
        : `Could not reach Buffer: ${(error as Error).message}`;

  return c.html(
    <Layout title="Buffer unavailable — Buffer → Calendar" user={user}>
      <h1>Buffer could not be reached</h1>
      <Notice kind="error">{message}</Notice>
      <div class="btn-row">
        <a class="btn btn-secondary" href="/calendars">
          Back to calendars
        </a>
        {error instanceof BufferAuthError ? (
          <form method="post" action="/signout">
            <button type="submit">Reconnect Buffer</button>
          </form>
        ) : null}
      </div>
    </Layout>,
    error instanceof BufferRateLimitError ? 429 : 502,
  );
}

calendarRoutes.get('/calendars/new', async (c) => {
  const user = c.get('user')!;
  const organizationId = c.req.query('org');

  try {
    const account = await accountFor(c.env, user.id);

    // Step 1: choose an organization. Skipped when there is only one.
    if (!organizationId) {
      if (account.organizations.length === 1) {
        return c.redirect(`/calendars/new?org=${account.organizations[0]!.id}`, 302);
      }
      return c.html(
        <Layout title="Choose an organization — Buffer → Calendar" user={user}>
          <div class="steps">
            <span class="on">1. Organization</span> <span>2. Channels</span> <span>3. Subscribe</span>
          </div>
          <h1>Which Buffer organization?</h1>
          <p class="lede">Each calendar covers channels from a single organization.</p>
          {account.organizations.map((org) => (
            <div class="card">
              <div class="cal-item">
                <div>
                  <h3>{org.name}</h3>
                  <div class="tags">{org.ownerEmail}</div>
                </div>
                <a class="btn btn-secondary" href={`/calendars/new?org=${org.id}`}>
                  Choose
                </a>
              </div>
            </div>
          ))}
        </Layout>,
      );
    }

    const organization = account.organizations.find((org) => org.id === organizationId);
    if (!organization) return c.redirect('/calendars/new', 302);

    // Step 2: choose channels and settings.
    const channels = await channelsFor(c.env, user.id, organizationId);
    const settings: CalendarSettings = {
      name: `Buffer — ${organization.name}`,
      channelIds: [],
      eventDurationMinutes: 15,
      refreshMinutes: 60,
      windowPastDays: 30,
      windowFutureDays: 90,
      statuses: ['scheduled', 'sent'],
      showChannelInTitle: true,
    };

    return c.html(
      <Layout title="Choose channels — Buffer → Calendar" user={user}>
        <div class="steps">
          <span>1. Organization</span> <span class="on">2. Channels</span> <span>3. Subscribe</span>
        </div>
        <h1>{organization.name}</h1>
        <p class="lede">Pick the channels whose posts should appear on the calendar.</p>

        <form method="post" action="/calendars">
          <input type="hidden" name="organizationId" value={organization.id} />
          <div class="card">
            {channels.length === 0 ? (
              <p class="small">This organization has no channels connected in Buffer.</p>
            ) : (
              <ChannelPicker channels={channels} selected={new Set()} />
            )}
          </div>

          <div class="card">
            <SettingsFields settings={settings} />
          </div>

          <div class="btn-row">
            <button type="submit" disabled={channels.length === 0}>
              Create calendar
            </button>
            <a class="btn btn-secondary" href="/calendars">
              Cancel
            </a>
          </div>
        </form>
      </Layout>,
    );
  } catch (error) {
    return bufferErrorPage(c, error);
  }
});

calendarRoutes.post('/calendars', async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.parseBody({ all: true })) as ParsedBody;
  const organizationId = toString(body['organizationId']);

  if (!organizationId) return c.redirect('/calendars/new', 302);

  try {
    const account = await accountFor(c.env, user.id);
    const organization = account.organizations.find((org) => org.id === organizationId);
    if (!organization) return c.redirect('/calendars/new', 302);

    const settings = readSettings(body, `Buffer — ${organization.name}`);

    // Resolve names from Buffer rather than trusting the submitted form, and so
    // a channel ID from another organization cannot be smuggled in.
    const available = await channelsFor(c.env, user.id, organizationId);
    const chosen = available.filter((channel) => settings.channelIds.includes(channel.id));

    if (!chosen.length) {
      return c.html(
        <Layout title="Choose channels — Buffer → Calendar" user={user}>
          <h1>Pick at least one channel</h1>
          <Notice kind="error">A calendar needs at least one channel to show anything.</Notice>
          <a class="btn" href={`/calendars/new?org=${organizationId}`}>
            Back
          </a>
        </Layout>,
        400,
      );
    }

    const calendar = await createCalendar(c.env.DB, {
      userId: user.id,
      organizationId,
      organizationName: organization.name,
      name: settings.name,
      channels: chosen.map((channel) => ({
        id: channel.id,
        name: channel.displayName?.trim() || channel.name,
        service: channel.service,
      })),
      eventDurationMinutes: settings.eventDurationMinutes,
      refreshMinutes: settings.refreshMinutes,
      windowPastDays: settings.windowPastDays,
      windowFutureDays: settings.windowFutureDays,
      statuses: settings.statuses,
      showChannelInTitle: settings.showChannelInTitle,
    });

    return c.redirect(`/calendars/${calendar.id}?created=1`, 302);
  } catch (error) {
    return bufferErrorPage(c, error);
  }
});

// -- show -------------------------------------------------------------------

calendarRoutes.get('/calendars/:id', async (c) => {
  const user = c.get('user')!;
  const calendar = await getCalendar(c.env.DB, c.req.param('id'), user.id);
  if (!calendar) return c.notFound();

  const urls = feedUrls(c.env.APP_BASE_URL, calendar.feed_token);
  const justCreated = c.req.query('created') === '1';
  const state = syncState(calendar);

  return c.html(
    <Layout title={`${calendar.name} — Buffer → Calendar`} user={user}>
      <div class="steps">
        <span>1. Organization</span> <span>2. Channels</span> <span class="on">3. Subscribe</span>
      </div>
      <h1>{calendar.name}</h1>
      <p class="lede">
        {calendar.organization_name} · {calendar.channels.map((ch) => ch.channel_name).join(', ')}
      </p>

      {justCreated ? <Notice>Your calendar is ready. Subscribe to it below.</Notice> : null}

      <div class="card">
        <h3>Subscription URL</h3>
        <p class="small">
          Anyone with this URL can read your post schedule, so treat it like a password. You can
          replace it below if it leaks.
        </p>
        <div class="url-box">
          <code>{urls.https}</code>
          <button type="button" class="btn-secondary" data-copy={urls.https}>
            Copy
          </button>
        </div>
        <div class="btn-row">
          <a class="btn" href={urls.google} target="_blank" rel="noreferrer noopener">
            Add to Google Calendar
          </a>
          <a class="btn btn-secondary" href={urls.webcal}>
            Add to Apple Calendar
          </a>
        </div>
      </div>

      <Notice>
        <p>
          <strong>How quickly it updates.</strong> Apple Calendar and Outlook honour the refresh
          interval you chose ({calendar.refresh_minutes >= 60
            ? `${Math.round(calendar.refresh_minutes / 60)}h`
            : `${calendar.refresh_minutes}m`}
          ). Google Calendar ignores it and re-fetches subscribed URLs on its own schedule —
          typically every 8–24 hours, with no way to force it sooner. If you need changes in Google
          within minutes, an ICS subscription cannot do it.
        </p>
      </Notice>

      <h2>Manual setup</h2>
      <div class="card">
        <p class="small">
          <strong>Google Calendar:</strong> Other calendars → + → From URL → paste the URL above.
          <br />
          <strong>Apple Calendar:</strong> File → New Calendar Subscription → paste the URL, then set
          Auto-refresh.
          <br />
          <strong>Outlook:</strong> Add calendar → Subscribe from web → paste the URL.
        </p>
      </div>

      <h2>Status</h2>
      <div class="card">
        <p class="small">
          <span class={`status-dot ${state.cls}`} />
          {state.text}
          {calendar.last_polled_at ? (
            <>
              <br />
              Last polled by a calendar app: {calendar.last_polled_at}
            </>
          ) : (
            <>
              <br />
              No calendar app has polled this feed yet.
            </>
          )}
        </p>
      </div>

      <h2>Manage</h2>
      <div class="card">
        <div class="btn-row">
          <a class="btn btn-secondary" href={`/calendars/${calendar.id}/edit`}>
            Edit settings
          </a>
          <form
            method="post"
            action={`/calendars/${calendar.id}/rotate`}
            onsubmit="return confirm('Replace the URL? You will need to re-subscribe in every calendar app.')"
          >
            <button class="btn btn-secondary" type="submit">
              Replace URL
            </button>
          </form>
          <form
            method="post"
            action={`/calendars/${calendar.id}/delete`}
            onsubmit="return confirm('Delete this calendar? The feed URL will stop working.')"
          >
            <button class="btn-danger" type="submit">
              Delete calendar
            </button>
          </form>
        </div>
      </div>
    </Layout>,
  );
});

// -- edit -------------------------------------------------------------------

calendarRoutes.get('/calendars/:id/edit', async (c) => {
  const user = c.get('user')!;
  const calendar = await getCalendar(c.env.DB, c.req.param('id'), user.id);
  if (!calendar) return c.notFound();

  try {
    const channels = await channelsFor(c.env, user.id, calendar.organization_id);
    const settings: CalendarSettings = {
      name: calendar.name,
      channelIds: calendar.channels.map((ch) => ch.channel_id),
      eventDurationMinutes: calendar.event_duration_minutes,
      refreshMinutes: calendar.refresh_minutes,
      windowPastDays: calendar.window_past_days,
      windowFutureDays: calendar.window_future_days,
      statuses: parseStatuses(calendar.statuses),
      showChannelInTitle: calendar.show_channel_in_title === 1,
    };

    return c.html(
      <Layout title={`Edit ${calendar.name} — Buffer → Calendar`} user={user}>
        <h1>Edit calendar</h1>
        <p class="lede">{calendar.organization_name}</p>

        <form method="post" action={`/calendars/${calendar.id}`}>
          <div class="card">
            <ChannelPicker channels={channels} selected={new Set(settings.channelIds)} />
          </div>
          <div class="card">
            <SettingsFields settings={settings} />
          </div>
          <div class="btn-row">
            <button type="submit">Save changes</button>
            <a class="btn btn-secondary" href={`/calendars/${calendar.id}`}>
              Cancel
            </a>
          </div>
        </form>
      </Layout>,
    );
  } catch (error) {
    return bufferErrorPage(c, error);
  }
});

calendarRoutes.post('/calendars/:id', async (c) => {
  const user = c.get('user')!;
  const calendar = await getCalendar(c.env.DB, c.req.param('id'), user.id);
  if (!calendar) return c.notFound();

  const body = (await c.req.parseBody({ all: true })) as ParsedBody;
  const settings = readSettings(body, calendar.name);

  try {
    const available = await channelsFor(c.env, user.id, calendar.organization_id);
    const chosen = available.filter((channel) => settings.channelIds.includes(channel.id));

    if (!chosen.length) {
      return c.redirect(`/calendars/${calendar.id}/edit`, 302);
    }

    await updateCalendar(c.env.DB, calendar.id, {
      name: settings.name,
      channels: chosen.map((channel) => ({
        id: channel.id,
        name: channel.displayName?.trim() || channel.name,
        service: channel.service,
      })),
      eventDurationMinutes: settings.eventDurationMinutes,
      refreshMinutes: settings.refreshMinutes,
      windowPastDays: settings.windowPastDays,
      windowFutureDays: settings.windowFutureDays,
      statuses: settings.statuses,
      showChannelInTitle: settings.showChannelInTitle,
    });

    return c.redirect(`/calendars/${calendar.id}`, 302);
  } catch (error) {
    return bufferErrorPage(c, error);
  }
});

calendarRoutes.post('/calendars/:id/rotate', async (c) => {
  const user = c.get('user')!;
  const calendar = await getCalendar(c.env.DB, c.req.param('id'), user.id);
  if (!calendar) return c.notFound();

  await rotateFeedToken(c.env.DB, calendar.id);
  return c.redirect(`/calendars/${calendar.id}`, 302);
});

calendarRoutes.post('/calendars/:id/delete', async (c) => {
  const user = c.get('user')!;
  const calendar = await getCalendar(c.env.DB, c.req.param('id'), user.id);
  if (!calendar) return c.notFound();

  await deleteCalendar(c.env.DB, calendar.id);
  return c.redirect('/calendars', 302);
});

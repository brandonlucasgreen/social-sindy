/**
 * Creating, viewing, and managing sindies (ICS or Atom feeds).
 *
 * Replaces the old calendars.tsx and feeds.tsx with a unified management UI
 * where the user picks a format (ICS or Atom) when creating a sindy.
 */

import { Hono } from 'hono';
import type { FC } from 'hono/jsx';

import { BufferAuthError, BufferRateLimitError } from '../buffer/client.js';
import { isPostStatus, type BufferChannel, type PostStatus } from '../buffer/types.js';
import {
  createOutput,
  deleteOutput,
  getOutput,
  listOutputs,
  parseStatuses,
  rotateFeedToken,
  updateOutput,
  type OutputFormat,
  type OutputWithChannels,
} from '../db.js';
import { getGoogleCredential } from '../db.js';
import { serviceColor, serviceLabel } from '../present.js';
import { googleConfig } from '../sync/google-config.js';
import { Layout, Notice, Steps } from '../ui/layout.jsx';
import {
  accountFor,
  channelsFor,
  requireUser,
  type AppBindings,
  type AppContext,
} from '../session.js';

export const outputRoutes = new Hono<AppBindings>();

outputRoutes.use('/sindies', requireUser);
outputRoutes.use('/sindies/*', requireUser);

// -- form option sets -------------------------------------------------------

const DURATION_OPTIONS = [
  [15, '15 minutes'],
  [30, '30 minutes'],
  [60, '1 hour'],
] as const;

const REFRESH_OPTIONS = [
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

const MAX_ITEMS_OPTIONS = [
  [25, '25 items'],
  [50, '50 items'],
  [100, '100 items'],
  [200, '200 items'],
] as const;

const STATUS_OPTIONS: { value: PostStatus; label: string; hint: string }[] = [
  { value: 'scheduled', label: 'Scheduled', hint: 'Queued and ready to publish' },
  { value: 'sent', label: 'Published', hint: 'Keeps a history in your feed' },
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

function pickNumber(value: string, allowed: readonly number[], fallback: number): number {
  const parsed = Number(value);
  return allowed.includes(parsed) ? parsed : fallback;
}

interface SindySettings {
  name: string;
  channelIds: string[];
  format: OutputFormat;
  eventDurationMinutes: number;
  showChannelInTitle: boolean;
  maxItems: number;
  groupCrossPosts: boolean;
  includeDrafts: boolean;
  refreshMinutes: number;
  windowPastDays: number;
  windowFutureDays: number;
  statuses: PostStatus[];
}

function readSettings(body: ParsedBody, fallbackName: string, format: OutputFormat): SindySettings {
  const channelIds = toStrings(body['channelIds']);

  if (format === 'atom') {
    // Atom feeds: only published posts by default, optional drafts toggle
    const includeDrafts = toStrings(body['includeDrafts']).length > 0;
    const statuses: PostStatus[] = ['sent'];
    if (includeDrafts) statuses.push('draft');

    return {
      name: toString(body['name']).trim().slice(0, 120) || fallbackName,
      channelIds,
      format,
      eventDurationMinutes: 15,
      showChannelInTitle: true,
      maxItems: pickNumber(
        toString(body['maxItems']),
        MAX_ITEMS_OPTIONS.map(([v]) => v),
        50,
      ),
      groupCrossPosts: toStrings(body['groupCrossPosts']).length > 0,
      includeDrafts,
      refreshMinutes: pickNumber(
        toString(body['refreshMinutes']),
        REFRESH_OPTIONS.map(([v]) => v),
        60,
      ),
      // Atom feeds don't use window settings — max_items caps the count
      windowPastDays: 30,
      windowFutureDays: 90,
      statuses,
    };
  }

  // ICS calendars: full status picker + window controls
  const statuses = toStrings(body['statuses']).filter(isPostStatus);

  return {
    name: toString(body['name']).trim().slice(0, 120) || fallbackName,
    channelIds,
    format,
    eventDurationMinutes: pickNumber(
      toString(body['eventDurationMinutes']),
      DURATION_OPTIONS.map(([v]) => v),
      15,
    ),
    showChannelInTitle: toStrings(body['showChannelInTitle']).length > 0,
    maxItems: 50,
    groupCrossPosts: true,
    includeDrafts: false,
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
    {channels.map((channel) => {
      const name = channel.displayName?.trim() || channel.name;
      const net = serviceColor(channel.service);
      return (
      <label class={channel.isDisconnected ? 'channel off' : 'channel'} style={`--net:${net}`}>
        <input
          type="checkbox"
          name="channelIds"
          value={channel.id}
          checked={selected.has(channel.id)}
        />
        {channel.avatar ? (
          <img class="avatar" src={channel.avatar} alt="" loading="lazy" />
        ) : (
          <span class="avatar fallback" aria-hidden="true">
            {Array.from(name)[0] ?? '?'}
          </span>
        )}
        <span class="meta">
          <strong>{name}</strong>
          <small>
            <span class="dot" aria-hidden="true" />
            {serviceLabel(channel.service)}
            {channel.isDisconnected ? ' · disconnected in Buffer' : ''}
          </small>
        </span>
      </label>
      );
    })}
  </div>
);

const IcsSettingsFields: FC<{ settings: SindySettings }> = ({ settings }) => (
  <>
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
        hint="Apple Calendar and Outlook will follow this refresh rate. Google Calendar may refresh less frequently, typically every 8-24 hours."
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
        Show the channel in the event title <small>— e.g. "🧵 kidlightbulbs: …"</small>
      </label>
    </div>
  </>
);

const AtomSettingsFields: FC<{ settings: SindySettings }> = ({ settings }) => (
  <>
    <h2>How it looks</h2>
    <div class="row">
      <Select
        name="maxItems"
        label="Maximum items"
        hint="How many posts to include in the feed. Older posts drop off as new ones come in."
        options={MAX_ITEMS_OPTIONS}
        value={settings.maxItems}
      />
      <Select
        name="refreshMinutes"
        label="Refresh interval"
        hint="How often to re-fetch from Buffer. RSS readers will see updates at this rate."
        options={REFRESH_OPTIONS}
        value={settings.refreshMinutes}
      />
    </div>

    <div class="checkline">
      <input
        type="checkbox"
        id="groupCrossPosts"
        name="groupCrossPosts"
        value="1"
        checked={settings.groupCrossPosts}
      />
      <label for="groupCrossPosts">
        Group cross-posts <small>— combine identical posts across channels into one entry</small>
      </label>
    </div>

    <div class="checkline">
      <input
        type="checkbox"
        id="includeDrafts"
        name="includeDrafts"
        value="1"
        checked={settings.includeDrafts}
      />
      <label for="includeDrafts">
        Include drafts <small>— also include scheduled drafts that have a date set</small>
      </label>
    </div>
  </>
);

const SharedSettingsFields: FC<{ settings: SindySettings }> = ({ settings }) => (
  <>
    <div class="field">
      <label for="name">{settings.format === 'ics' ? 'Calendar name' : 'Feed name'}</label>
      <input type="text" id="name" name="name" value={settings.name} maxlength={120} required />
      <small>Shown as the name in your calendar or feed reader app.</small>
    </div>

    {settings.format === 'ics' ? (
      <>
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
      </>
    ) : (
      <h2>What to include</h2>
    )}
  </>
);

// -- dashboard --------------------------------------------------------------

function feedUrls(baseUrl: string, token: string, format: OutputFormat) {
  const ext = format === 'ics' ? '.ics' : '.xml';
  const https = `${baseUrl.replace(/\/$/, '')}/feed/${token}${ext}`;
  if (format === 'ics') {
    return {
      https,
      webcal: https.replace(/^https?:/, 'webcal:'),
      google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(https)}`,
    };
  }
  return { https };
}

function syncState(output: OutputWithChannels): { cls: string; text: string } {
  if (output.last_error) return { cls: 'bad', text: `Last refresh failed: ${output.last_error}` };
  if (!output.last_fetched_at) return { cls: 'stale', text: 'Not fetched yet' };

  const ageMinutes = Math.round((Date.now() - Date.parse(output.last_fetched_at)) / 60_000);
  const stale = ageMinutes > output.refresh_minutes * 3;
  const when =
    ageMinutes < 1 ? 'just now' : ageMinutes < 60 ? `${ageMinutes}m ago` : `${Math.round(ageMinutes / 60)}h ago`;

  const noun = output.format === 'ics' ? 'events' : 'items';

  return {
    cls: stale ? 'stale' : '',
    text: `Refreshed ${when}${output.last_event_count !== null ? ` · ${output.last_event_count} ${noun}` : ''}`,
  };
}

function pushStatus(output: OutputWithChannels): { cls: string; text: string } | null {
  if (output.last_push_error) {
    return { cls: 'bad', text: `Last sync failed: ${output.last_push_error}` };
  }
  if (!output.last_push_at) return { cls: 'stale', text: 'Not synced yet' };

  const ageMinutes = Math.round((Date.now() - Date.parse(output.last_push_at)) / 60_000);
  const when =
    ageMinutes < 1 ? 'just now' : ageMinutes < 60 ? `${ageMinutes}m ago` : `${Math.round(ageMinutes / 60)}h ago`;

  let detail = '';
  if (output.last_push_stats) {
    try {
      const stats = JSON.parse(output.last_push_stats) as {
        created: number;
        updated: number;
        deleted: number;
      };
      const parts = [
        stats.created ? `${stats.created} added` : '',
        stats.updated ? `${stats.updated} updated` : '',
        stats.deleted ? `${stats.deleted} removed` : '',
      ].filter(Boolean);
      detail = parts.length ? ` · ${parts.join(', ')}` : ' · no changes';
    } catch {
      // Malformed stats are cosmetic
    }
  }

  return { cls: '', text: `Synced ${when}${detail}` };
}

const FORMAT_LABEL: Record<OutputFormat, string> = {
  ics: 'Calendar (ICS)',
  atom: 'Feed (Atom/RSS)',
};

outputRoutes.get('/sindies', async (c) => {
  const user = c.get('user')!;
  const outputs = await listOutputs(c.env.DB, user.id);

  return c.html(
    <Layout title="Your sindies — social sindy" user={user}>
      <h1>Your sindies</h1>
      <p class="lede">Each sindy is one subscribable feed of your Buffer schedule — a calendar or a content feed.</p>

      {outputs.length === 0 ? (
        <div class="panel">
          <div class="empty">
            <p>You have not created a sindy yet.</p>
            <a class="btn" href="/sindies/new">
              Create your first sindy
            </a>
          </div>
        </div>
      ) : (
        <>
          {outputs.map((output) => {
            const state = syncState(output);
            return (
              <div class="panel">
                <div class="cal">
                  <div>
                    <h3>
                      <a href={`/sindies/${output.id}`}>{output.name}</a>
                    </h3>
                    <div class="meta-line">
                      {output.organization_name} · {output.channels.length}{' '}
                      {output.channels.length === 1 ? 'channel' : 'channels'} · {FORMAT_LABEL[output.format]}
                    </div>
                    <div class="meta-line">
                      <span class={`state ${state.cls}`} />
                      {state.text}
                    </div>
                  </div>
                  <a class="btn btn-quiet" href={`/sindies/${output.id}`}>
                    {output.format === 'ics' ? 'Subscribe' : 'View'}
                  </a>
                </div>
              </div>
            );
          })}
          <div class="btn-row">
            <a class="btn" href="/sindies/new">
              New sindy
            </a>
          </div>
        </>
      )}

      <h2>Account</h2>
      <div class="panel">
        <p class="small">
          Signed in as {user.email}. Deleting your account removes your stored Buffer credential and
          every sindy you created here. It does not touch anything in Buffer.
        </p>
        <form
          method="post"
          action="/account/delete"
          onsubmit="return confirm('Delete your account, stored credential, and all sindies? Existing feed URLs will stop working.')"
        >
          <button class="btn-danger" type="submit">
            Delete account and stored credential
          </button>
        </form>
      </div>
    </Layout>,
  );
});

// -- create -----------------------------------------------------------------

function bufferErrorPage(c: AppContext, error: unknown) {
  const user = c.get('user')!;
  const message =
    error instanceof BufferAuthError
      ? 'Buffer rejected your stored credential. It may have been revoked — reconnect to continue.'
      : error instanceof BufferRateLimitError
        ? "Buffer's API rate limit is exhausted for your account. Try again in a few minutes."
        : `Could not reach Buffer: ${(error as Error).message}`;

  return c.html(
    <Layout title="Buffer unavailable — social sindy" user={user}>
      <h1>Buffer could not be reached</h1>
      <Notice kind="error">{message}</Notice>
      <div class="btn-row">
        <a class="btn btn-quiet" href="/sindies">
          Back to sindies
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

outputRoutes.get('/sindies/new', async (c) => {
  const user = c.get('user')!;
  const organizationId = c.req.query('org');
  const format = (c.req.query('format') === 'atom' ? 'atom' : 'ics') as OutputFormat;

  try {
    const account = await accountFor(c.env, user.id);

    if (!organizationId) {
      if (account.organizations.length === 1) {
        return c.redirect(`/sindies/new?org=${account.organizations[0]!.id}&format=${format}`, 302);
      }
      return c.html(
        <Layout title="Choose an organization — social sindy" user={user} narrow>
          <Steps at={1} />
          <h1>Which Buffer organization?</h1>
          <p class="lede">Each sindy covers channels from a single organization.</p>
          {account.organizations.map((org) => (
            <div class="panel">
              <div class="cal">
                <div>
                  <h3>{org.name}</h3>
                  <div class="meta-line">{org.ownerEmail}</div>
                </div>
                <a class="btn btn-quiet" href={`/sindies/new?org=${org.id}&format=${format}`}>
                  Choose
                </a>
              </div>
            </div>
          ))}
        </Layout>,
      );
    }

    const organization = account.organizations.find((org) => org.id === organizationId);
    if (!organization) return c.redirect('/sindies/new', 302);

    const channels = await channelsFor(c.env, user.id, organizationId);
    const settings: SindySettings = {
      name: `Buffer — ${organization.name}`,
      channelIds: [],
      format,
      eventDurationMinutes: 15,
      showChannelInTitle: true,
      maxItems: 50,
      groupCrossPosts: true,
      includeDrafts: false,
      refreshMinutes: 60,
      windowPastDays: 30,
      windowFutureDays: 90,
      statuses: format === 'ics' ? ['scheduled', 'sent'] : ['sent'],
    };

    return c.html(
      <Layout title="Choose channels — social sindy" user={user}>
        <Steps at={2} />
        <h1>{organization.name}</h1>
        <p class="lede">
          {format === 'ics'
            ? 'Pick the channels whose posts should appear on the calendar.'
            : 'Pick the channels whose posts should appear in the feed.'}
        </p>

        <div class="format-toggle" style="margin-bottom:1.5rem">
          <a class={`fmt-btn ${format === 'ics' ? 'active' : ''}`}
             href={`/sindies/new?org=${organizationId}&format=ics`}>
            Calendar (ICS)
          </a>
          <a class={`fmt-btn ${format === 'atom' ? 'active' : ''}`}
             href={`/sindies/new?org=${organizationId}&format=atom`}>
            Feed (Atom/RSS)
          </a>
        </div>

        <form method="post" action="/sindies">
          <input type="hidden" name="organizationId" value={organization.id} />
          <input type="hidden" name="format" value={format} />
          <div class="panel">
            {channels.length === 0 ? (
              <p class="small">This organization has no channels connected in Buffer.</p>
            ) : (
              <ChannelPicker channels={channels} selected={new Set()} />
            )}
          </div>

          <div class="panel">
            <SharedSettingsFields settings={settings} />
            {format === 'ics' ? <IcsSettingsFields settings={settings} /> : <AtomSettingsFields settings={settings} />}
          </div>

          <div class="btn-row">
            <button type="submit" disabled={channels.length === 0}>
              Create {format === 'ics' ? 'calendar' : 'feed'}
            </button>
            <a class="btn btn-quiet" href="/sindies">
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

outputRoutes.post('/sindies', async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.parseBody({ all: true })) as ParsedBody;
  const organizationId = toString(body['organizationId']);
  const format = (toString(body['format']) === 'atom' ? 'atom' : 'ics') as OutputFormat;

  if (!organizationId) return c.redirect('/sindies/new', 302);

  try {
    const account = await accountFor(c.env, user.id);
    const organization = account.organizations.find((org) => org.id === organizationId);
    if (!organization) return c.redirect('/sindies/new', 302);

    const settings = readSettings(body, `Buffer — ${organization.name}`, format);

    const available = await channelsFor(c.env, user.id, organizationId);
    const chosen = available.filter((channel) => settings.channelIds.includes(channel.id));

    if (!chosen.length) {
      return c.html(
        <Layout title="Choose channels — social sindy" user={user}>
          <h1>Pick at least one channel</h1>
          <Notice kind="error">A sindy needs at least one channel to show anything.</Notice>
          <a class="btn" href={`/sindies/new?org=${organizationId}&format=${format}`}>
            Back
          </a>
        </Layout>,
        400,
      );
    }

    const output = await createOutput(c.env.DB, {
      userId: user.id,
      organizationId,
      organizationName: organization.name,
      name: settings.name,
      format: settings.format,
      channels: chosen.map((channel) => ({
        id: channel.id,
        name: channel.displayName?.trim() || channel.name,
        service: channel.service,
      })),
      eventDurationMinutes: settings.eventDurationMinutes,
      showChannelInTitle: settings.showChannelInTitle,
      maxItems: settings.maxItems,
      groupCrossPosts: settings.groupCrossPosts,
      refreshMinutes: settings.refreshMinutes,
      windowPastDays: settings.windowPastDays,
      windowFutureDays: settings.windowFutureDays,
      statuses: settings.statuses,
    });

    return c.redirect(`/sindies/${output.id}?created=1`, 302);
  } catch (error) {
    return bufferErrorPage(c, error);
  }
});

// -- show -------------------------------------------------------------------

outputRoutes.get('/sindies/:id', async (c) => {
  const user = c.get('user')!;
  const output = await getOutput(c.env.DB, c.req.param('id'), user.id);
  if (!output) return c.notFound();

  const urls = feedUrls(c.env.APP_BASE_URL, output.feed_token, output.format);
  const justCreated = c.req.query('created') === '1';
  const state = syncState(output);

  const isIcs = output.format === 'ics';
  const pushAvailable = isIcs && googleConfig(c.env) !== null;
  const googleConnected = pushAvailable && (await getGoogleCredential(c.env.DB, user.id)) !== null;
  const pushState = isIcs ? pushStatus(output) : null;

  return c.html(
    <Layout title={`${output.name} — social sindy`} user={user}>
      <Steps at={3} />
      <h1>{output.name}</h1>
      <p class="lede">
        {output.organization_name} · {output.channels.map((ch) => ch.channel_name).join(', ')}
      </p>

      {justCreated ? <Notice>Your {isIcs ? 'calendar' : 'feed'} is ready. Subscribe to it below.</Notice> : null}

      <div class="panel">
        <h3>Subscription URL</h3>
        <p class="small">
          Anyone with this URL can read your post schedule, so treat it like a password. You can
          replace it below if it leaks.
        </p>
        <div class="url">
          <code>{urls.https}</code>
          <button type="button" class="btn-quiet" data-copy={urls.https}>
            Copy
          </button>
        </div>
        {isIcs ? (
          <div class="btn-row">
            <a class="btn" href={urls.google!} target="_blank" rel="noreferrer noopener">
              Add to Google Calendar
            </a>
            <a class="btn btn-quiet" href={urls.webcal!}>
              Add to Apple Calendar
            </a>
          </div>
        ) : null}
      </div>

      {isIcs ? (
        <Notice>
          <p>
            <strong>How quickly it updates.</strong> Apple Calendar and Outlook will follow the
            refresh rate you chose ({output.refresh_minutes >= 60
              ? `${Math.round(output.refresh_minutes / 60)}h`
              : `${output.refresh_minutes}m`}
            ). Google Calendar may refresh less frequently, typically every 8-24 hours, and does not
            offer a way to refresh on demand.
          </p>
        </Notice>
      ) : (
        <Notice>
          <p>
            <strong>How quickly it updates.</strong> RSS readers will follow the refresh rate you
            chose ({output.refresh_minutes >= 60
              ? `${Math.round(output.refresh_minutes / 60)}h`
              : `${output.refresh_minutes}m`}
            ). Your feed reader may poll on its own schedule.
          </p>
        </Notice>
      )}

      {isIcs ? (
        <>
          <h2>Manual setup</h2>
          <div class="panel">
            <p class="small">
              <strong>Google Calendar:</strong> Other calendars → + → From URL → paste the URL above.
              <br />
              <strong>Apple Calendar:</strong> File → New Calendar Subscription → paste the URL, then set
              Auto-refresh.
              <br />
              <strong>Outlook:</strong> Add calendar → Subscribe from web → paste the URL.
            </p>
          </div>
        </>
      ) : null}

      <h2>Status</h2>
      <div class="panel">
        <p class="small">
          <span class={`state ${state.cls}`} />
          {state.text}
          {output.last_polled_at ? (
            <>
              <br />
              Last polled by a client: {output.last_polled_at}
            </>
          ) : (
            <>
              <br />
              No client has polled this feed yet.
            </>
          )}
        </p>
      </div>

      {isIcs ? (
        <>
          <h2>Google Calendar sync</h2>
          {!pushAvailable ? (
            <div class="panel">
              <p class="small">
                Direct Google sync is not configured on this deployment, so the subscription URL above is
                the way to get this into Google — refreshed on Google's own schedule.
              </p>
            </div>
          ) : output.push_enabled === 1 ? (
            <div class="panel">
              <h3>On</h3>
              <p class="small">
                Events are written straight into a Google calendar named "{output.name}", so changes
                appear within your refresh interval instead of waiting on Google's 8-24 hour polling.
                Only events created by this tool are ever touched.
              </p>
              {pushState ? (
                <p class="meta-line">
                  <span class={`state ${pushState.cls}`} />
                  {pushState.text}
                </p>
              ) : null}
              <div class="btn-row">
                <form method="post" action={`/sindies/${output.id}/push/now`}>
                  <button class="btn btn-quiet" type="submit">
                    Sync now
                  </button>
                </form>
                <form method="post" action={`/sindies/${output.id}/push/disable`}>
                  <button class="btn btn-quiet" type="submit">
                    Turn off
                  </button>
                </form>
                <form
                  method="post"
                  action={`/sindies/${output.id}/push/remove`}
                  onsubmit="return confirm('Delete the Google calendar this tool created, and all events in it?')"
                >
                  <button class="btn-danger" type="submit">
                    Delete the Google calendar
                  </button>
                </form>
              </div>
            </div>
          ) : (
            <div class="panel">
              <p class="small">
                Google ignores the refresh interval on subscribed URLs. Turning this on writes events
                directly into a dedicated Google calendar instead, so changes land within minutes.
              </p>
              <p class="small">
                It asks for one permission — create a calendar and manage events on calendars it created.
                It cannot see your existing calendars.
              </p>
              <div class="btn-row">
                <form method="post" action={`/sindies/${output.id}/push/enable`}>
                  <button type="submit">{googleConnected ? 'Turn on Google sync' : 'Connect Google'}</button>
                </form>
              </div>
            </div>
          )}
        </>
      ) : null}

      <h2>Manage</h2>
      <div class="panel">
        <div class="btn-row">
          <a class="btn btn-quiet" href={`/sindies/${output.id}/edit`}>
            Edit settings
          </a>
          <form
            method="post"
            action={`/sindies/${output.id}/rotate`}
            onsubmit="return confirm('Replace the URL? You will need to re-subscribe in every app.')"
          >
            <button class="btn btn-quiet" type="submit">
              Replace URL
            </button>
          </form>
          <form
            method="post"
            action={`/sindies/${output.id}/delete`}
            onsubmit="return confirm('Delete this sindy? The feed URL will stop working.')"
          >
            <button class="btn-danger" type="submit">
              Delete sindy
            </button>
          </form>
        </div>
      </div>
    </Layout>,
  );
});

// -- edit -------------------------------------------------------------------

outputRoutes.get('/sindies/:id/edit', async (c) => {
  const user = c.get('user')!;
  const output = await getOutput(c.env.DB, c.req.param('id'), user.id);
  if (!output) return c.notFound();

  try {
    const channels = await channelsFor(c.env, user.id, output.organization_id);
    const settings: SindySettings = {
      name: output.name,
      channelIds: output.channels.map((ch) => ch.channel_id),
      format: output.format,
      eventDurationMinutes: output.event_duration_minutes,
      showChannelInTitle: output.show_channel_in_title === 1,
      maxItems: output.max_items,
      groupCrossPosts: output.group_cross_posts === 1,
      includeDrafts: output.statuses.split(',').includes('draft'),
      refreshMinutes: output.refresh_minutes,
      windowPastDays: output.window_past_days,
      windowFutureDays: output.window_future_days,
      statuses: parseStatuses(output.statuses),
    };

    return c.html(
      <Layout title={`Edit ${output.name} — social sindy`} user={user}>
        <h1>Edit {output.format === 'ics' ? 'calendar' : 'feed'}</h1>
        <p class="lede">{output.organization_name} · {FORMAT_LABEL[output.format]}</p>

        <form method="post" action={`/sindies/${output.id}`}>
          <input type="hidden" name="format" value={output.format} />
          <div class="panel">
            <ChannelPicker channels={channels} selected={new Set(settings.channelIds)} />
          </div>
          <div class="panel">
            <SharedSettingsFields settings={settings} />
            {output.format === 'ics' ? <IcsSettingsFields settings={settings} /> : <AtomSettingsFields settings={settings} />}
          </div>
          <div class="btn-row">
            <button type="submit">Save changes</button>
            <a class="btn btn-quiet" href={`/sindies/${output.id}`}>
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

outputRoutes.post('/sindies/:id', async (c) => {
  const user = c.get('user')!;
  const output = await getOutput(c.env.DB, c.req.param('id'), user.id);
  if (!output) return c.notFound();

  const body = (await c.req.parseBody({ all: true })) as ParsedBody;
  const settings = readSettings(body, output.name, output.format);

  try {
    const available = await channelsFor(c.env, user.id, output.organization_id);
    const chosen = available.filter((channel) => settings.channelIds.includes(channel.id));

    if (!chosen.length) {
      return c.redirect(`/sindies/${output.id}/edit`, 302);
    }

    await updateOutput(c.env.DB, output.id, {
      name: settings.name,
      channels: chosen.map((channel) => ({
        id: channel.id,
        name: channel.displayName?.trim() || channel.name,
        service: channel.service,
      })),
      eventDurationMinutes: settings.eventDurationMinutes,
      showChannelInTitle: settings.showChannelInTitle,
      maxItems: settings.maxItems,
      groupCrossPosts: settings.groupCrossPosts,
      refreshMinutes: settings.refreshMinutes,
      windowPastDays: settings.windowPastDays,
      windowFutureDays: settings.windowFutureDays,
      statuses: settings.statuses,
    });

    return c.redirect(`/sindies/${output.id}`, 302);
  } catch (error) {
    return bufferErrorPage(c, error);
  }
});

outputRoutes.post('/sindies/:id/rotate', async (c) => {
  const user = c.get('user')!;
  const output = await getOutput(c.env.DB, c.req.param('id'), user.id);
  if (!output) return c.notFound();

  await rotateFeedToken(c.env.DB, output.id);
  return c.redirect(`/sindies/${output.id}`, 302);
});

outputRoutes.post('/sindies/:id/delete', async (c) => {
  const user = c.get('user')!;
  const output = await getOutput(c.env.DB, c.req.param('id'), user.id);
  if (!output) return c.notFound();

  await deleteOutput(c.env.DB, output.id);
  return c.redirect('/sindies', 302);
});
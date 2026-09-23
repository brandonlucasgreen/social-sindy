/**
 * Creating, viewing, and managing sindies (ICS feeds, Atom feeds, or
 * embeddable widgets).
 *
 * Replaces the old calendars.tsx and feeds.tsx with a unified management UI
 * where the user picks a format when creating a sindy.
 */

import { Hono } from 'hono';
import type { FC } from 'hono/jsx';

import { BufferAuthError, BufferRateLimitError } from '../buffer/client.js';
import { isPostStatus, type BufferChannel, type PostStatus } from '../buffer/types.js';
import {
  createOutput,
  deleteOutput,
  getOutput,
  isOutputFormat,
  listOutputs,
  parseStatuses,
  rotateFeedToken,
  updateOutput,
  type OutputFormat,
  type OutputWithChannels,
} from '../db.js';
import { avatarCssValue, proxiedAvatarUrl } from '../avatar.js';
import type { Env } from '../env.js';
import { channelInitial, serviceColor, serviceLabel } from '../present.js';
import { Layout, Notice, Steps } from '../ui/layout.jsx';
import {
  DEFAULT_WIDGET_POST_COUNT,
  DEFAULT_WIDGET_STYLE,
  HEIGHT_MAX,
  HEIGHT_MIN,
  WIDGET_FONTS,
  WIDGET_FONT_SIZES,
  WIDGET_POST_COUNTS,
  WIDGET_RADII,
  WIDGET_THEMES,
  WIDTH_MAX,
  embedSnippet,
  embedUrl,
  normalizeWidgetStyle,
  parseWidgetStyle,
  serializeWidgetStyle,
  type WidgetStyle,
} from '../widget/style.js';
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

function parseFormat(value: string | undefined): OutputFormat {
  return value && isOutputFormat(value) ? value : 'ics';
}

function checked(body: ParsedBody, name: string): boolean {
  return toStrings(body[name]).length > 0;
}

/**
 * A widget's URL is pasted into a public website, so it only ever shows what is
 * already public: published posts. Scheduled posts and drafts are never
 * offered. The window reaches a year back because the Buffer query is sorted
 * newest-first and capped at the card count, so a wide window costs nothing.
 */
const WIDGET_STATUSES: PostStatus[] = ['sent'];
const WIDGET_PAST_DAYS = 365;

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
  widgetStyle: WidgetStyle;
}

function readSettings(body: ParsedBody, fallbackName: string, format: OutputFormat): SindySettings {
  const channelIds = toStrings(body['channelIds']);

  if (format === 'widget') {
    return {
      name: toString(body['name']).trim().slice(0, 120) || fallbackName,
      channelIds,
      format,
      eventDurationMinutes: 15,
      showChannelInTitle: true,
      maxItems: pickNumber(toString(body['maxItems']), WIDGET_POST_COUNTS, DEFAULT_WIDGET_POST_COUNT),
      groupCrossPosts: checked(body, 'groupCrossPosts'),
      includeDrafts: false,
      refreshMinutes: pickNumber(
        toString(body['refreshMinutes']),
        REFRESH_OPTIONS.map(([v]) => v),
        60,
      ),
      windowPastDays: WIDGET_PAST_DAYS,
      windowFutureDays: 0,
      statuses: WIDGET_STATUSES,
      widgetStyle: normalizeWidgetStyle({
        theme: toString(body['theme']),
        accent: toString(body['accent']),
        font: toString(body['font']),
        fontSize: toString(body['fontSize']),
        radius: toString(body['radius']),
        width: toString(body['width']) || 0,
        height: toString(body['height']),
        transparent: checked(body, 'transparent'),
        showHeader: checked(body, 'showHeader'),
        showChannel: checked(body, 'showChannel'),
        showMedia: checked(body, 'showMedia'),
      }),
    };
  }

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
      widgetStyle: DEFAULT_WIDGET_STYLE,
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
    widgetStyle: DEFAULT_WIDGET_STYLE,
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

/**
 * A channel plus the same-origin URL its avatar is reachable at, resolved by
 * `withProxiedAvatars` before render because signing is async and a hono/jsx
 * component is not.
 */
type PickerChannel = BufferChannel & { avatarUrl: string | null };

/**
 * Signs each channel's avatar URL for the proxy. See `src/avatar.ts` — the raw
 * Buffer URLs point at third-party CDNs the CSP does not allow, so they cannot
 * be rendered directly.
 */
async function withProxiedAvatars(
  env: Pick<Env, 'ENCRYPTION_KEY'>,
  channels: BufferChannel[],
): Promise<PickerChannel[]> {
  return Promise.all(
    channels.map(async (channel) => ({
      ...channel,
      avatarUrl: await proxiedAvatarUrl(env, channel.avatar),
    })),
  );
}

/**
 * The avatar disc: the channel's initial on its network's brand colour, with
 * the photo laid over it when there is one.
 *
 * The photo is a `background-image` rather than an `<img>` on purpose — a
 * background-image that fails to load renders nothing, so a channel whose
 * avatar 404s, expires (LinkedIn's URLs carry an `e=` expiry), or is simply
 * missing falls back to the initial with no broken-image glyph and no
 * JavaScript involved. See the `.channel .avatar` rules in ui/layout.tsx.
 */
const Avatar: FC<{ channel: PickerChannel; name: string }> = ({ channel, name }) => (
  <span
    class="avatar"
    aria-hidden="true"
    data-initial={channelInitial(name)}
    style={channel.avatarUrl ? `--photo:${avatarCssValue(channel.avatarUrl)}` : undefined}
  >
    <span class="photo" />
  </span>
);

const ChannelPicker: FC<{ channels: PickerChannel[]; selected: Set<string> }> = ({
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
        <Avatar channel={channel} name={name} />
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

const Check: FC<{ name: string; checked: boolean; label: string; hint?: string }> = ({
  name,
  checked,
  label,
  hint,
}) => (
  <div class="checkline">
    <input type="checkbox" id={name} name={name} value="1" checked={checked} />
    <label for={name}>
      {label} {hint ? <small>— {hint}</small> : null}
    </label>
  </div>
);

const WidgetSettingsFields: FC<{ settings: SindySettings }> = ({ settings }) => {
  const style = settings.widgetStyle;
  return (
    <>
      <div class="row">
        <Select
          name="maxItems"
          label="Posts to show"
          hint="Only published posts, newest first."
          options={WIDGET_POST_COUNTS.map((n) => [n, `${n} posts`] as const)}
          value={settings.maxItems}
        />
        <Select
          name="refreshMinutes"
          label="Refresh interval"
          hint="How often new posts are picked up from Buffer."
          options={REFRESH_OPTIONS}
          value={settings.refreshMinutes}
        />
      </div>
      <Check
        name="groupCrossPosts"
        checked={settings.groupCrossPosts}
        label="Group cross-posts"
        hint="show a post sent to several channels once"
      />

      <h2>How it looks</h2>
      <div class="row">
        <div class="field">
          <label for="theme">Color scheme</label>
          <select id="theme" name="theme">
            {WIDGET_THEMES.map(([value, label]) => (
              <option value={value} selected={value === style.theme}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="accent">Accent color</label>
          <input type="color" id="accent" name="accent" value={style.accent} />
          <small>Used for links.</small>
        </div>
      </div>

      <div class="row">
        <div class="field">
          <label for="font">Font</label>
          <select id="font" name="font">
            {Object.entries(WIDGET_FONTS).map(([key, font]) => (
              <option value={key} selected={key === style.font}>
                {font.label}
              </option>
            ))}
          </select>
        </div>
        <Select
          name="fontSize"
          label="Font size"
          options={WIDGET_FONT_SIZES.map((n) => [n, `${n}px`] as const)}
          value={style.fontSize}
        />
        <Select name="radius" label="Corners" options={WIDGET_RADII} value={style.radius} />
      </div>

      <div class="row">
        <div class="field">
          <label for="width">Max width (px)</label>
          <input type="number" id="width" name="width" value={String(style.width)} min={0} max={WIDTH_MAX} step={10} />
          <small>0 fills whatever space the page gives it.</small>
        </div>
        <div class="field">
          <label for="height">Height (px)</label>
          <input
            type="number"
            id="height"
            name="height"
            value={String(style.height)}
            min={HEIGHT_MIN}
            max={HEIGHT_MAX}
            step={10}
          />
          <small>Posts that don't fit scroll inside the widget.</small>
        </div>
      </div>

      <Check name="showHeader" checked={style.showHeader} label="Show the title" hint="above the posts" />
      <Check name="showChannel" checked={style.showChannel} label="Show the channel" hint="name and network on each post" />
      <Check name="showMedia" checked={style.showMedia} label="Show images" hint="up to four per post" />
      <Check
        name="transparent"
        checked={style.transparent}
        label="Transparent background"
        hint="let your page's background show between posts"
      />
    </>
  );
};

const SettingsFields: FC<{ settings: SindySettings }> = ({ settings }) =>
  settings.format === 'ics' ? (
    <IcsSettingsFields settings={settings} />
  ) : settings.format === 'atom' ? (
    <AtomSettingsFields settings={settings} />
  ) : (
    <WidgetSettingsFields settings={settings} />
  );

const NAME_LABEL: Record<OutputFormat, string> = {
  ics: 'Calendar name',
  atom: 'Feed name',
  widget: 'Widget title',
};

const NAME_HINT: Record<OutputFormat, string> = {
  ics: 'Shown as the name in your calendar app.',
  atom: 'Shown as the name in your feed reader app.',
  widget: 'Shown above your posts, if you keep the title on.',
};

const SharedSettingsFields: FC<{ settings: SindySettings }> = ({ settings }) => (
  <>
    <div class="field">
      <label for="name">{NAME_LABEL[settings.format]}</label>
      <input type="text" id="name" name="name" value={settings.name} maxlength={120} required />
      <small>{NAME_HINT[settings.format]}</small>
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
  if (format === 'widget') return { https: embedUrl(baseUrl, token) };
  const ext = format === 'ics' ? '.ics' : '.xml';
  const https = `${baseUrl.replace(/\/$/, '')}/feed/${token}${ext}`;
  return { https };
}

function syncState(output: OutputWithChannels): { cls: string; text: string } {
  if (output.last_error) return { cls: 'bad', text: `Last refresh failed: ${output.last_error}` };
  if (!output.last_fetched_at) return { cls: 'stale', text: 'Not fetched yet' };

  const ageMinutes = Math.round((Date.now() - Date.parse(output.last_fetched_at)) / 60_000);
  const stale = ageMinutes > output.refresh_minutes * 3;
  const when =
    ageMinutes < 1 ? 'just now' : ageMinutes < 60 ? `${ageMinutes}m ago` : `${Math.round(ageMinutes / 60)}h ago`;

  const noun = output.format === 'ics' ? 'events' : output.format === 'atom' ? 'items' : 'posts';

  return {
    cls: stale ? 'stale' : '',
    text: `Refreshed ${when}${output.last_event_count !== null ? ` · ${output.last_event_count} ${noun}` : ''}`,
  };
}

const FORMAT_LABEL: Record<OutputFormat, string> = {
  ics: 'Calendar (ICS)',
  atom: 'Feed (Atom/RSS)',
  widget: 'Embeddable widget',
};

/** What a sindy of each format is called in running copy. */
const FORMAT_NOUN: Record<OutputFormat, string> = {
  ics: 'calendar',
  atom: 'feed',
  widget: 'widget',
};

const FORMATS: OutputFormat[] = ['ics', 'atom', 'widget'];

const CHANNEL_PROMPT: Record<OutputFormat, string> = {
  ics: 'Pick the channels whose posts should appear on the calendar.',
  atom: 'Pick the channels whose posts should appear in the feed.',
  widget: 'Pick the channels whose published posts should appear in the widget.',
};

function storedWidgetStyle(settings: SindySettings): string | null {
  return settings.format === 'widget' ? serializeWidgetStyle(settings.widgetStyle) : null;
}

outputRoutes.get('/sindies', async (c) => {
  const user = c.get('user')!;
  const outputs = await listOutputs(c.env.DB, user.id);

  return c.html(
    <Layout title="Your sindies — social sindy" user={user}>
      <h1>Your sindies</h1>
      <p class="lede">
        Each sindy is one view of your Buffer posts — a calendar, a content feed, or a widget for
        your website.
      </p>

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
                    {output.format === 'ics' ? 'Subscribe' : output.format === 'widget' ? 'Embed' : 'View'}
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
  const format = parseFormat(c.req.query('format'));

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

    const channels = await withProxiedAvatars(
      c.env,
      await channelsFor(c.env, user.id, organizationId),
    );
    const settings: SindySettings = {
      name: `Buffer — ${organization.name}`,
      channelIds: [],
      format,
      eventDurationMinutes: 15,
      showChannelInTitle: true,
      maxItems: format === 'widget' ? DEFAULT_WIDGET_POST_COUNT : 50,
      groupCrossPosts: true,
      includeDrafts: false,
      refreshMinutes: 60,
      windowPastDays: format === 'widget' ? WIDGET_PAST_DAYS : 30,
      windowFutureDays: format === 'widget' ? 0 : 90,
      statuses: format === 'ics' ? ['scheduled', 'sent'] : ['sent'],
      widgetStyle: DEFAULT_WIDGET_STYLE,
    };

    return c.html(
      <Layout title="Choose channels — social sindy" user={user}>
        <Steps at={2} />
        <h1>{organization.name}</h1>
        <p class="lede">{CHANNEL_PROMPT[format]}</p>

        <div class="format-toggle" style="margin-bottom:1.5rem">
          {FORMATS.map((f) => (
            <a class={`fmt-btn ${format === f ? 'active' : ''}`} href={`/sindies/new?org=${organizationId}&format=${f}`}>
              {FORMAT_LABEL[f]}
            </a>
          ))}
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
            <SettingsFields settings={settings} />
          </div>

          <div class="btn-row">
            <button type="submit" disabled={channels.length === 0}>
              Create {FORMAT_NOUN[format]}
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
  const format = parseFormat(toString(body['format']));

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
      widgetStyle: storedWidgetStyle(settings),
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

/**
 * Embed code and a live preview. The preview frames the real embed URL, but by
 * path rather than the absolute origin, so it also works on a preview deploy
 * or local dev whose host differs from APP_BASE_URL.
 */
const WidgetEmbedPanels: FC<{ output: OutputWithChannels; baseUrl: string }> = ({ output, baseUrl }) => {
  const style = parseWidgetStyle(output.widget_style);
  const snippet = embedSnippet(baseUrl, output.feed_token, output.name, style);
  const direct = embedUrl(baseUrl, output.feed_token);
  const previewStyle = `width:100%;${style.width ? `max-width:${style.width}px;` : ''}height:${style.height}px`;

  return (
    <>
      <div class="panel">
        <h3>Embed code</h3>
        <p class="small">
          Paste this into your website, blog, or link-in-bio page wherever it accepts HTML. Unlike
          calendar and feed URLs, this one is meant to be public: it only ever shows posts that are
          already published.
        </p>
        <div class="snippet">
          <code>{snippet}</code>
          <button type="button" class="btn-quiet" data-copy={snippet}>
            Copy embed code
          </button>
        </div>
        <p class="small">
          Only takes a link? Use the widget URL on its own:
        </p>
        <div class="url">
          <code>{direct}</code>
          <button type="button" class="btn-quiet" data-copy={direct}>
            Copy
          </button>
        </div>
      </div>

      <h2>Preview</h2>
      <div class="panel">
        <iframe
          class="preview"
          src={`/embed/${output.feed_token}`}
          title={`Preview of ${output.name}`}
          style={previewStyle}
          loading="lazy"
        />
      </div>
    </>
  );
};

outputRoutes.get('/sindies/:id', async (c) => {
  const user = c.get('user')!;
  const output = await getOutput(c.env.DB, c.req.param('id'), user.id);
  if (!output) return c.notFound();

  const urls = feedUrls(c.env.APP_BASE_URL, output.feed_token, output.format);
  const justCreated = c.req.query('created') === '1';
  const state = syncState(output);

  const isIcs = output.format === 'ics';
  const isWidget = output.format === 'widget';
  const refreshLabel =
    output.refresh_minutes >= 60 ? `${Math.round(output.refresh_minutes / 60)}h` : `${output.refresh_minutes}m`;

  return c.html(
    <Layout title={`${output.name} — social sindy`} user={user}>
      <Steps at={3} />
      <h1>{output.name}</h1>
      <p class="lede">
        {output.organization_name} · {output.channels.map((ch) => ch.channel_name).join(', ')}
      </p>

      {justCreated ? (
        <Notice>
          Your {FORMAT_NOUN[output.format]} is ready.{' '}
          {isWidget ? 'Copy the embed code below into your site.' : 'Subscribe to it below.'}
        </Notice>
      ) : null}

      {isWidget ? <WidgetEmbedPanels output={output} baseUrl={c.env.APP_BASE_URL} /> : (
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
      </div>
      )}

      {isWidget ? (
        <Notice>
          <p>
            <strong>How quickly it updates.</strong> New posts show up within the refresh interval
            you chose ({refreshLabel}) of being published. Every visitor to your page is served
            the same cached copy, so traffic to your site never spends your Buffer quota.
          </p>
        </Notice>
      ) : isIcs ? (
        <Notice>
          <p>
            <strong>How quickly it updates.</strong> Apple Calendar and Outlook will follow the
            refresh rate you chose ({refreshLabel}). Google Calendar may refresh less frequently, typically every 8-24 hours, and does not
            offer a way to refresh on demand.
          </p>
        </Notice>
      ) : (
        <Notice>
          <p>
            <strong>How quickly it updates.</strong> RSS readers will follow the refresh rate you
            chose ({refreshLabel}). Your feed reader may poll on its own schedule.
          </p>
        </Notice>
      )}

      <h2>Status</h2>
      <div class="panel">
        <p class="small">
          <span class={`state ${state.cls}`} />
          {state.text}
          {isWidget ? null : output.last_polled_at ? (
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

      <h2>Manage</h2>
      <div class="panel">
        <div class="btn-row">
          <a class="btn btn-quiet" href={`/sindies/${output.id}/edit`}>
            Edit settings
          </a>
          <form
            method="post"
            action={`/sindies/${output.id}/rotate`}
            onsubmit={
              isWidget
                ? "return confirm('Replace the URL? The widget will stop working on every site until you paste the new embed code.')"
                : "return confirm('Replace the URL? You will need to re-subscribe in every app.')"
            }
          >
            <button class="btn btn-quiet" type="submit">
              Replace URL
            </button>
          </form>
          <form
            method="post"
            action={`/sindies/${output.id}/delete`}
            onsubmit={
              isWidget
                ? "return confirm('Delete this widget? It will stop working on every site it is embedded in.')"
                : "return confirm('Delete this sindy? The feed URL will stop working.')"
            }
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
    const channels = await withProxiedAvatars(
      c.env,
      await channelsFor(c.env, user.id, output.organization_id),
    );
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
      widgetStyle: parseWidgetStyle(output.widget_style),
    };

    return c.html(
      <Layout title={`Edit ${output.name} — social sindy`} user={user}>
        <h1>Edit {FORMAT_NOUN[output.format]}</h1>
        <p class="lede">{output.organization_name} · {FORMAT_LABEL[output.format]}</p>

        <form method="post" action={`/sindies/${output.id}`}>
          <input type="hidden" name="format" value={output.format} />
          <div class="panel">
            <ChannelPicker channels={channels} selected={new Set(settings.channelIds)} />
          </div>
          <div class="panel">
            <SharedSettingsFields settings={settings} />
            <SettingsFields settings={settings} />
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
      widgetStyle: storedWidgetStyle(settings),
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
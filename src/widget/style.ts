/**
 * Appearance settings for an embeddable widget.
 *
 * Everything here ends up interpolated into CSS or an embed snippet, so every
 * value is checked against an allowlist or a strict pattern on the way in AND
 * on the way out of the database. Nothing the user types reaches a stylesheet
 * verbatim — a font is picked by key, a colour must be a six-digit hex, and a
 * dimension is a clamped integer.
 */

export type WidgetTheme = 'auto' | 'light' | 'dark';

export interface WidgetFont {
  label: string;
  /** CSS font-family stack. */
  stack: string;
  /** coolLabs Fonts css2 `family=` value, or null for a system stack. */
  webFont: string | null;
}

/**
 * Curated rather than free-form: a free-text family name would be a CSS
 * injection vector and would also silently fall back to Times for any typo.
 * Web fonts load from coolLabs Fonts, the same privacy-friendly Google Fonts
 * mirror the app itself uses, so embedding a widget does not hand visitors'
 * IP addresses to Google.
 */
export const WIDGET_FONTS = {
  system: {
    label: 'System sans-serif',
    stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    webFont: null,
  },
  serif: {
    label: 'System serif',
    stack: 'ui-serif, Georgia, "Times New Roman", serif',
    webFont: null,
  },
  mono: {
    label: 'System monospace',
    stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    webFont: null,
  },
  snpro: {
    label: 'SN Pro',
    stack: '"SN Pro", ui-sans-serif, system-ui, sans-serif',
    webFont: 'SN+Pro:wght@400;600',
  },
  inter: {
    label: 'Inter',
    stack: 'Inter, ui-sans-serif, system-ui, sans-serif',
    webFont: 'Inter:wght@400;600',
  },
  spacegrotesk: {
    label: 'Space Grotesk',
    stack: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
    webFont: 'Space+Grotesk:wght@400;600',
  },
  lora: {
    label: 'Lora',
    stack: 'Lora, ui-serif, Georgia, serif',
    webFont: 'Lora:wght@400;600',
  },
  plexmono: {
    label: 'IBM Plex Mono',
    stack: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    webFont: 'IBM+Plex+Mono:wght@400;600',
  },
} as const satisfies Record<string, WidgetFont>;

export type WidgetFontKey = keyof typeof WIDGET_FONTS;

export const WIDGET_THEMES: readonly (readonly [WidgetTheme, string])[] = [
  ['auto', "Match the visitor's system"],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

export const WIDGET_FONT_SIZES = [13, 14, 15, 16, 17, 18, 20] as const;

export const WIDGET_RADII: readonly (readonly [number, string])[] = [
  [0, 'Square'],
  [6, 'Slightly rounded'],
  [14, 'Rounded'],
];

/** How many posts a widget can show. Also stored in `outputs.max_items`. */
export const WIDGET_POST_COUNTS = [3, 5, 10, 20, 50] as const;
export const DEFAULT_WIDGET_POST_COUNT = 5;

export const WIDTH_MIN = 240;
export const WIDTH_MAX = 1600;
export const HEIGHT_MIN = 200;
export const HEIGHT_MAX = 3000;

export interface WidgetStyle {
  theme: WidgetTheme;
  /** Six-digit lowercase hex, `#rrggbb`. */
  accent: string;
  font: WidgetFontKey;
  fontSize: number;
  radius: number;
  /** Max width in px; 0 means fill the container (100%). */
  width: number;
  height: number;
  transparent: boolean;
  showHeader: boolean;
  showChannel: boolean;
  showMedia: boolean;
}

export const DEFAULT_WIDGET_STYLE: WidgetStyle = {
  theme: 'auto',
  accent: '#4a8ad4',
  font: 'system',
  fontSize: 15,
  radius: 14,
  width: 0,
  height: 600,
  transparent: false,
  showHeader: true,
  showChannel: true,
  showMedia: true,
};

const HEX = /^#[0-9a-f]{6}$/i;

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Coerces anything into a valid style, defaulting field by field.
 *
 * Used both for form input and for the stored JSON, so a row written by an
 * older version, or edited by hand, can never produce invalid CSS.
 */
export function normalizeWidgetStyle(input: Partial<Record<keyof WidgetStyle, unknown>>): WidgetStyle {
  const d = DEFAULT_WIDGET_STYLE;
  const accent = typeof input.accent === 'string' && HEX.test(input.accent) ? input.accent.toLowerCase() : d.accent;
  const width = clampInt(input.width, 0, WIDTH_MAX, d.width);

  return {
    theme: pick(input.theme, WIDGET_THEMES.map(([v]) => v), d.theme),
    accent,
    font: pick(input.font, Object.keys(WIDGET_FONTS) as WidgetFontKey[], d.font),
    fontSize: pick(Number(input.fontSize), WIDGET_FONT_SIZES, d.fontSize),
    radius: pick(Number(input.radius), WIDGET_RADII.map(([v]) => v), d.radius),
    // Anything below the minimum that isn't 0 is treated as "too narrow to be
    // useful" and bumped up, rather than silently switching to full width.
    width: width === 0 ? 0 : Math.max(WIDTH_MIN, width),
    height: clampInt(input.height, HEIGHT_MIN, HEIGHT_MAX, d.height),
    transparent: bool(input.transparent, d.transparent),
    showHeader: bool(input.showHeader, d.showHeader),
    showChannel: bool(input.showChannel, d.showChannel),
    showMedia: bool(input.showMedia, d.showMedia),
  };
}

export function parseWidgetStyle(stored: string | null | undefined): WidgetStyle {
  if (!stored) return { ...DEFAULT_WIDGET_STYLE };
  try {
    const parsed: unknown = JSON.parse(stored);
    if (parsed && typeof parsed === 'object') return normalizeWidgetStyle(parsed as Record<string, unknown>);
  } catch {
    // Fall through to defaults: a corrupt row must not take the widget down.
  }
  return { ...DEFAULT_WIDGET_STYLE };
}

export function serializeWidgetStyle(style: WidgetStyle): string {
  return JSON.stringify(normalizeWidgetStyle(style));
}

/** The URL a site embeds in its iframe. */
export function embedUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/embed/${token}`;
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The copy-paste snippet. Width and height live on the iframe, not the page
 * inside it: the embedded document is fluid and fills whatever box the host
 * gives it, scrolling internally when there are more posts than fit.
 */
export function embedSnippet(baseUrl: string, token: string, title: string, style: WidgetStyle): string {
  const width = style.width === 0 ? 'width:100%' : `width:100%;max-width:${style.width}px`;
  const css = `${width};height:${style.height}px;border:0;${style.transparent ? 'background:transparent;' : ''}`;
  return (
    `<iframe src="${escapeAttr(embedUrl(baseUrl, token))}" title="${escapeAttr(title)}" ` +
    `style="${css}" loading="lazy"${style.transparent ? ' allowtransparency="true"' : ''}></iframe>`
  );
}

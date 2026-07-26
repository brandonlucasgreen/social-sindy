/**
 * The product mark. One source of truth: the masthead logo, the favicon route,
 * and the PNG uploaded to Buffer's OAuth client are all rendered from the
 * string below, so they cannot drift apart.
 *
 * Reads as a calendar first — the two hanger pegs are the load-bearing signal,
 * since a bare rounded square with bars in it is just as much a list or a menu
 * icon. Inside, two event bars of unequal width stand for scheduled posts: the
 * thing this tool actually puts into your calendar.
 *
 * Colours are literals rather than CSS variables. The mark has to rasterize to
 * PNG outside any document, and `--accent` is identical in light and dark, so
 * there is nothing for a variable to buy here.
 */

const NAVY = '#1d283a'; // hsl(217 33% 17%) — --text (light)
const ACCENT = '#a8c7f0'; // hsl(214 70% 80%) — --accent

/**
 * Standalone SVG document. `viewBox` is 32×32 so every coordinate lands on a
 * half-pixel at the 24px the masthead renders it at.
 */
export const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="social cally">
  <rect x="8.75" y="1.5" width="3.5" height="7" rx="1.75" fill="${NAVY}"/>
  <rect x="19.75" y="1.5" width="3.5" height="7" rx="1.75" fill="${NAVY}"/>
  <rect x="2" y="4.5" width="28" height="26" rx="7" fill="${ACCENT}"/>
  <rect x="2" y="11.5" width="28" height="1.25" fill="${NAVY}" opacity="0.22"/>
  <rect x="7" y="16.5" width="18" height="3.5" rx="1.75" fill="${NAVY}"/>
  <rect x="7" y="22.5" width="11" height="3.5" rx="1.75" fill="${NAVY}" opacity="0.45"/>
</svg>`;

/** Inline mark for the masthead. Decorative — the brand text carries the name. */
export const Mark = () => (
  <span class="brand-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: MARK_SVG }} />
);

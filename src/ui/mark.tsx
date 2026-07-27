/**
 * The product mark. A broadcast signal — concentric arcs emanating from a
 * center dot inside a rounded square — in amber on warm charcoal.
 *
 * Reads as "RSS broadcast" first: the arcs are the load-bearing signal that
 * this tool syndicates your content outward. The rounded square contains them
 * the way a calendar contains event bars.
 *
 * Colours are literals rather than CSS variables. The mark has to rasterize
 * outside any document context.
 */

const CHARCOAL = '#2d2419'; // hsl(30 10% 16%) — --text (light)
const AMBER = '#d4913d';     // hsl(35 65% 53%) — warm amber accent

/**
 * Standalone SVG document. `viewBox` is 32×32 so every coordinate lands on a
 * half-pixel at the 24px the masthead renders it at.
 */
export const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="social sindy">
  <rect x="2" y="2" width="28" height="28" rx="7" fill="${AMBER}"/>
  <circle cx="16" cy="19" r="2.5" fill="${CHARCOAL}"/>
  <path d="M11.5 14.5a6.5 6.5 0 0 1 9 0" stroke="${CHARCOAL}" stroke-width="2" stroke-linecap="round" fill="none"/>
  <path d="M8 11a11 11 0 0 1 16 0" stroke="${CHARCOAL}" stroke-width="2" stroke-linecap="round" fill="none"/>
</svg>`;

/** Inline mark for the masthead. Decorative — the brand text carries the name. */
export const Mark = () => (
  <span class="brand-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: MARK_SVG }} />
);
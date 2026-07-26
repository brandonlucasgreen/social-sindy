# Design

Durable visual rules for social-cally. Product truth lives in [PRODUCT.md](PRODUCT.md).

The world is **brand-adjacent to Buffer**: close enough that a Buffer user feels
at home immediately, never close enough to pass as first-party. No Buffer logo or
wordmark. Tokens below were read from buffer.com's own published custom
properties, so they are Buffer's real values, not an approximation.

## Color

Buffer's ground is **warm**, and its text is **dark teal, never black**. That
warmth is the single most recognizable thing about the palette; a neutral gray
ground loses the brand instantly.

| Role | Light | Dark |
| --- | --- | --- |
| Page ground | `hsl(40 43% 99%)` | `hsl(176 20% 16%)` |
| Raised surface | `hsl(0 0% 100%)` | `hsl(177 22% 20%)` |
| Sunken / inset | `hsl(60 20% 96%)` | `hsl(176 22% 13%)` |
| Text primary | `hsl(176 20% 16%)` | `hsl(40 43% 99%)` |
| Text secondary | `hsl(60 3% 42%)` | `hsl(60 8% 72%)` |
| Border | `hsl(53 8% 78%)` | `hsl(176 14% 30%)` |
| Primary action | `hsl(105 68% 77%)` mint, **dark text on it** | same mint, dark text |
| Link | `hsl(139 37% 32%)` | `hsl(105 68% 77%)` |

Dark mode is derived from Buffer's own `--color-brand-core-dark` and its
`*-inverse` tokens rather than invented, so both schemes stay in the same family.

**Strategy: restrained.** Neutrals plus mint, because the visitor came to operate.
The pastel range below is reserved for identity, never decoration.

The primary action is mint with **dark** text — not white on saturated color. This
is the most easily lost detail in the palette and the most recognizable.

### Accent range

Buffer publishes eight core pastels: purple `hsl(258 100% 88%)`, coral
`hsl(7 100% 83%)`, yellow `hsl(40 100% 77%)`, blue `hsl(207 100% 84%)`, green
`hsl(105 68% 77%)`, aqua `hsl(174 64% 77%)`, pink `hsl(336 100% 85%)`, fuchsia
`hsl(289 100% 87%)`. Use for identity and wayfinding only.

### Per-network color

Buffer publishes real brand colors per network, and channels are the primary
content of this app, so use them: threads `hsl(0 0% 0%)`, bluesky
`hsl(211 99% 53%)`, instagram `hsl(331 98% 47%)`, linkedin `hsl(213 63% 43%)`,
mastodon `hsl(240 100% 69%)`, youtube `hsl(0 100% 50%)`, facebook
`hsl(214 89% 52%)`, pinterest `hsl(351 100% 45%)`, x `hsl(0 0% 0%)`, tiktok
`hsl(0 0% 0%)`, googlebusiness `hsl(220 72% 59%)`.

**Wherever a user makes a decision about a channel, never carry its identity by
color alone.** The picker distinguishes many similar networks and several share
black, so there the color always sits beside the network's name.

Illustrative surfaces are the exception, scoped deliberately: the hero's sample
week renders network-tinted event blocks with truncated titles, the way a real
calendar client does, because nothing there is selectable and no decision depends
on telling two hues apart. The network name is still exposed via `title`.

## Type

`Figtree` for everything, self-described weight range 400–700. Buffer sets
headings in `Stolzl`, which is proprietary and unavailable to us; Figtree is
Buffer's real body face, so using it throughout is faithful rather than a
substitution.

The signature is **large headings at regular-to-medium weight with tight negative
tracking**, not bold headings. Buffer's own `--font-weight-heading` is `400`.

- Headings: 500 weight, `-0.02em` tracking, `1.1` line height
- Body: 400, `1.5`, secondary text tinted from the teal hue — never gray
- Prose measure caps at 68ch
- Fluid sizing via `clamp()`, mirroring Buffer's step scale

## Shape and depth

Buffer's radii are generous and its depth is **chunky**, not subtle:

- `--radius-sm: 0.625rem` · `--radius-md: 1.25rem` · `--radius-lg: 2.5rem`
- Buttons and chips are **full pills** (`100vmax`)
- Signature card shadow keeps Buffer's third layer — a **solid, un-blurred 8px
  offset in dark teal** beneath the soft ambient layers. That sticker-like edge is
  the brand's most distinctive structural device; dropping it for a soft shadow is
  what makes a Buffer-styled page look generic.

Interactive cards press *into* that offset on active, shrinking it — the motion
the object would have in life.

## Motion

One authored moment: `150ms ease-out`, matching Buffer's own transition tokens.
Applies to the press of a control and the settle of a selection. No scroll
animation, no scattered hover effects.

## Prohibitions

Specific to this world, checked against its own materials:

- No white text on the mint primary. Dark teal on mint, always.
- No gray secondary text. Tint from the teal hue.
- No Buffer logo or wordmark, and nothing implying first-party status.
- No colored left border above 1px as a category marker. Buffer's world carries
  category through a tinted fill plus a solid dot, not a stripe.
- No tracked uppercase eyebrows. Buffer sets small labels in sentence case at
  medium weight; uppercase micro-labels are a different product's grammar.
- The offset shadow is for raised interactive objects only; nesting it inside
  another shadowed container reads as noise.

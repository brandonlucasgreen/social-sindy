# Design

Durable visual rules for social-cally. Product truth lives in [PRODUCT.md](PRODUCT.md).

The world is **adjacent to Buffer in structure, not in livery**. A Buffer user
should feel the shapes are familiar while never mistaking this for a Buffer
product. No Buffer logo or wordmark, not Buffer's typeface, and since 2026-07-26
not Buffer's colours either. What remains borrowed is *geometry* — pill controls,
the 10/20/40px radii, the fluid type and space scales, and the offset "sticker
edge" shadow — all read from buffer.com's published custom properties.

## Color

The palette is **cool**: a slate ground and navy text, never black, with a single
steel-blue accent. This replaced a warm cream ground with Buffer's mint primary.
The old palette was faithful to Buffer to the point of implying endorsement,
which is the wrong signal for a third-party tool holding other people's tokens.

| Role | Light | Dark |
| --- | --- | --- |
| Page ground | `hsl(215 32% 98%)` | `hsl(217 33% 14%)` |
| Raised surface | `hsl(0 0% 100%)` | `hsl(217 27% 18%)` |
| Sunken / inset | `hsl(215 26% 95%)` | `hsl(217 33% 11%)` |
| Text primary | `hsl(217 33% 17%)` | `hsl(215 32% 97%)` |
| Text secondary | `hsl(215 14% 45%)` | `hsl(215 16% 72%)` |
| Border | `hsl(215 16% 79%)` | `hsl(215 14% 31%)` |
| Primary action | `hsl(214 70% 80%)`, **dark text on it** | same, dark text |
| Link | `hsl(217 61% 38%)` | `hsl(214 70% 80%)` |

Both schemes sit on the same two hues — `215` for neutrals, `214`/`217` for
accent and depth — so nothing in the interface reads as a different family.

**Strategy: restrained.** Neutrals plus one accent, because the visitor came to
operate. Saturated colour is reserved for network identity, never decoration.

The primary action keeps **dark text on a light accent** rather than white on a
saturated fill. That was the most recognizable detail of the old palette and the
one structural habit worth carrying over — it keeps buttons quiet enough to sit
inside a form without shouting.

Warning and danger colours stay warm (amber, coral) because they are semantic,
not brand: a cool-shifted warning stops reading as a warning.

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

`SN Pro` for everything, weights 400–700, from Google Fonts.

This is a deliberate step away from Buffer's own type. The tool is third-party
and unaffiliated, so it should not read as Buffer-issued — SN Pro is the face
used across `bgreen.lol`, which places this in its author's world rather than
Buffer's. The palette and layout still take cues from the product it reads from,
which is honest: it is a companion to Buffer, and looking like a stranger to it
would serve nobody. Typography is where the authorship line gets drawn.

The signature is **large headings at regular-to-medium weight with tight negative
tracking**, not bold headings.

- Headings: 500 weight, `-0.02em` tracking, `1.1` line height
- Body: 400, `1.5`, secondary text tinted from the slate hue — never neutral gray
- Prose measure caps at 68ch
- Fluid sizing via `clamp()`, mirroring Buffer's step scale

## Shape and depth

Buffer's radii are generous and its depth is **chunky**, not subtle:

- `--radius-sm: 0.625rem` · `--radius-md: 1.25rem` · `--radius-lg: 2.5rem`
- Buttons and chips are **full pills** (`100vmax`)
- Signature card shadow keeps the three-layer structure — a **solid, un-blurred
  8px offset in dark navy** beneath the soft ambient layers. That sticker-like
  edge is the most distinctive structural device carried over from Buffer;
  dropping it for a soft shadow is what makes the page look generic. The hue
  moved with the palette, the construction did not.

Interactive cards press *into* that offset on active, shrinking it — the motion
the object would have in life.

## Motion

One authored moment: `150ms ease-out`, matching Buffer's own transition tokens.
Applies to the press of a control and the settle of a selection. No scroll
animation, no scattered hover effects.

## Prohibitions

Specific to this world, checked against its own materials:

- No white text on the accent primary. Dark navy on steel blue, always.
- No neutral gray secondary text. Tint from the slate hue.
- No mint, and no warm cream ground. Those are Buffer's, and reintroducing them
  re-implies endorsement no matter what the footer says.
- No Buffer logo or wordmark, and nothing implying first-party status.
- No colored left border above 1px as a category marker. Buffer's world carries
  category through a tinted fill plus a solid dot, not a stripe.
- No tracked uppercase eyebrows. Buffer sets small labels in sentence case at
  medium weight; uppercase micro-labels are a different product's grammar.
- The offset shadow is for raised interactive objects only; nesting it inside
  another shadowed container reads as noise.

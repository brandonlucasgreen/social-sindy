# Social Sindy — Design

## Palette

Cool steel-blue on a near-white ground. A publishing tool sits alongside a
calendar and an RSS reader all day, so the chrome stays quiet and lets the
network-colored post chips carry the only real color on the page.

Source of truth is `:root` in [src/ui/layout.tsx](src/ui/layout.tsx).

### Light

| Token | Value | Use |
|-------|-------|-----|
| `--ground` | `hsl(210 20% 97%)` | Page background |
| `--raised` | `hsl(0 0% 100%)` | Cards, panels |
| `--sunken` | `hsl(210 16% 94%)` | Inputs, wells |
| `--text` | `hsl(210 15% 16%)` | Body text |
| `--text-dim` | `hsl(210 10% 44%)` | Secondary text |
| `--border` | `hsl(210 12% 80%)` | Input borders |
| `--border-soft` | `hsl(210 16% 88%)` | Dividers |
| `--accent` | `hsl(210 55% 60%)` | Primary buttons, active states |
| `--accent-deep` | `hsl(210 60% 48%)` | Button hover |
| `--link` | `hsl(210 70% 38%)` | Links |
| `--edge` | `hsl(210 20% 18%)` | Card shadow edge |

### Dark

| Token | Value | Use |
|-------|-------|-----|
| `--ground` | `hsl(210 15% 14%)` | Page background |
| `--raised` | `hsl(210 12% 18%)` | Cards, panels |
| `--sunken` | `hsl(210 16% 11%)` | Inputs, wells |
| `--text` | `hsl(210 20% 96%)` | Body text |
| `--text-dim` | `hsl(210 10% 70%)` | Secondary text |
| `--border` | `hsl(210 8% 30%)` | Input borders |
| `--border-soft` | `hsl(210 6% 24%)` | Dividers |
| `--accent` | `hsl(210 55% 65%)` | Primary buttons, active states |
| `--accent-deep` | `hsl(210 60% 55%)` | Button hover |
| `--link` | `hsl(210 55% 65%)` | Links |
| `--edge` | `hsl(210 15% 8%)` | Card shadow edge |

Both schemes are declared under `color-scheme: light dark`, so the OS setting
picks one without a toggle.

### Status colors

`--warn-bg` / `--warn-edge` / `--warn-text` carry the amber notice styling, and
`--danger` (`hsl(7 62% 44%)`) marks destructive actions. These stay warm in both
schemes on purpose — a warning that matches the chrome does not read as a
warning.

### Note on the warm palette

An earlier revision used a warm cream-and-amber palette, on the reasoning that a
broadcast-oriented creative tool suited warm color. It was replaced with the cool
palette above, which is closer to what the project used before that. The brand
mark still carries the amber (see **Mark** below).

## Typography

- **Typeface:** SN Pro (loaded from Google Fonts), with system-ui fallback
- **Body:** `clamp(1rem, 0.96rem + 0.22vi, 1.125rem)`, line-height 1.5
- **Headlines:** 500 weight, `-0.025em` tracking, `text-wrap: balance`
- **Code:** `ui-monospace, SFMono-Regular, Menlo`

## Geometry

- **Pill controls:** `border-radius: 100vmax` (`--pill`) on buttons and inputs
- **Panels:** `border-radius: 1.25rem` (`--radius-md`)
- **Small radius:** `border-radius: 0.625rem` (`--radius-sm`) on selects
- **Large radius:** `border-radius: 2.5rem` (`--radius-lg`)

## Motion

`--dur: 150ms` with `--ease: cubic-bezier(0.22, 1, 0.36, 1)` — a fast
decelerating curve, applied to hover and active state changes only.

## Depth

`--shadow-card` has three layers: two soft ambient shadows over a solid 8px
offset that reads as a physical edge (the "sticker edge"). This is Buffer's own
card shadow pattern, and it survived the recolor unchanged. `--shadow-raised` is
the lighter two-layer version for smaller raised elements.

## Mark

A broadcast signal — concentric arcs emanating from a center dot inside a
rounded square. Reads as "RSS broadcast" first. Amber fill (`#d4913d`) with
charcoal strokes (`#2d2419`), rendered as inline SVG in the masthead and served
standalone from `/icon.svg` as the favicon.

The mark still uses the warm amber from the earlier palette and was not
recolored alongside the UI, so it currently reads as a deliberate accent against
the steel blue rather than as a matched element. Worth a decision: recolor it to
`--accent`, or keep the amber as the brand's one warm note.

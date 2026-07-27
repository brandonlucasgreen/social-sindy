# Social Sindy — Design

## Palette

Warm cream ground with amber accent. The product is called "Sindy" (syndication + independent), and the warm palette suits a creative, broadcast-oriented tool.

### Light

| Token | Value | Use |
|-------|-------|-----|
| `--ground` | `hsl(40 33% 97%)` | Page background |
| `--raised` | `hsl(0 0% 100%)` | Cards, panels |
| `--sunken` | `hsl(40 26% 94%)` | Inputs, wells |
| `--text` | `hsl(30 10% 16%)` | Body text |
| `--text-dim` | `hsl(30 8% 44%)` | Secondary text |
| `--border` | `hsl(30 12% 80%)` | Input borders |
| `--accent` | `hsl(35 85% 68%)` | Primary buttons, active states |
| `--accent-deep` | `hsl(35 75% 55%)` | Button hover |
| `--link` | `hsl(25 80% 38%)` | Links |
| `--edge` | `hsl(30 20% 18%)` | Card shadow edge |

### Dark

| Token | Value | Use |
|-------|-------|-----|
| `--ground` | `hsl(30 10% 14%)` | Page background |
| `--raised` | `hsl(30 8% 18%)` | Cards, panels |
| `--sunken` | `hsl(30 12% 11%)` | Inputs, wells |
| `--text` | `hsl(40 30% 96%)` | Body text |
| `--text-dim` | `hsl(30 10% 70%)` | Secondary text |
| `--accent` | `hsl(35 85% 68%)` | Primary buttons, active states |
| `--accent-deep` | `hsl(35 80% 58%)` | Button hover |
| `--link` | `hsl(35 85% 68%)` | Links |
| `--edge` | `hsl(30 15% 8%)` | Card shadow edge |

### Note on the cool palette

The previous social-cally used a cool slate-and-steel-blue palette. It's retained here as a historical note. If per-format theming is added later (cool for ICS, warm for Atom), the values are:

```
--ground: hsl(215 32% 98%);
--raised: hsl(0 0% 100%);
--sunken: hsl(215 26% 95%);
--text: hsl(217 33% 17%);
--accent: hsl(214 70% 80%);
--link: hsl(217 61% 38%);
```

## Typography

- **Typeface:** SN Pro (loaded from Google Fonts), with system-ui fallback
- **Body:** `clamp(1rem, 0.96rem + 0.22vi, 1.125rem)`, line-height 1.5
- **Headlines:** 500 weight, `-0.025em` tracking, `text-wrap: balance`
- **Code:** `ui-monospace, SFMono-Regular, Menlo`

## Geometry

- **Pill controls:** `border-radius: 100vmax` on buttons and inputs
- **Panels:** `border-radius: 1.25rem`
- **Small radius:** `border-radius: 0.625rem` on selects

## Depth

The card shadow has three layers: two soft ambient shadows over a solid 8px offset that reads as a physical edge (the "sticker edge"). This is Buffer's own card shadow pattern, retained across both the cool and warm palettes.

## Mark

A broadcast signal — concentric arcs emanating from a center dot inside a rounded square. Reads as "RSS broadcast" first. Amber fill, charcoal strokes. Rendered as inline SVG in the masthead and as a standalone SVG for the favicon.
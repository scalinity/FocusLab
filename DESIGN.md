# Focus Lab — design

The visual language follows the interactive piece *The Plane of Focus — a lens, opened up*
(sael.net/plane-of-focus, Ryan Sael, 2026), extracted with Firecrawl and Exa on 2026-10-08.
Only the design system and the scene idea are taken from it: no code, shaders, models, title
treatment or site chrome (view counter, share, follow, "also check out", "got an idea").

## Scene

One full-window, orbitable 3D scene: an optical bench standing on the forest floor.

- **Object space at true scale.** The life-size forest, the three subjects' ray bundles (fat
  HDR lines) and the **plane-of-focus sheet**: a glowing translucent sheet at s_o in front of the
  lens, spanning the camera's field of view, with a bright **cut line** where it meets geometry.
- **Image space magnified ×N** on the same optical axis, behind the lens plane: the glass
  element, iris blades, the barrel cutaway with focus ring, helicoid and engraved distance scale,
  and the **image plane** showing the live image upside down, with each subject's blur circle
  drawn on it in the aperture's shape. The lens plane carries the labelled scale break
  ("image space ×N").
- **Viewfinder screen.** The photoreal render through the lens, composited as an exact-pixel 3:2
  card at the bottom of the window (glass frame, flipped upright as a camera's screen does). One
  key switches it to full screen: "look through the lens".
- Lighting: warm low sun behind the forest, cool shadows; the bench is dark metal and anodised
  black with amber (brass) accents on the rings, the glass reads cyan at its edges.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0b0f1a` | page and canvas clear |
| `--ink` | `#eef2fa` | primary text |
| `--mute` | `#9ea8c2` | labels, secondary text |
| `--dim` | `#8d97b3` | chip labels |
| `--line` | `#ffffff1c` | hairline borders |
| `--glass` | `linear-gradient(150deg, #141a2ae8, #0d1220e3)` + `backdrop-filter: blur(14px)` | cards |
| `--chip` | `#0d1220c4` + `blur(8px)` | stat chips, small panels |
| `--cyan` | `#7fe3ff` | focus, plane of focus, active values, focus ring of UI |
| `--amber` | `#ffb454` | secondary accent: brass, warnings, past-infinity |
| shadow | `0 18px 50px -20px #000a` | cards |

Radii: card 16 px, chip 10 px, segmented track 11 px / button 9 px, icon button 10–12 px.
Spacing: window inset 24 px (12 px under 900 px wide), card padding 9–10 px, gaps 6–10 px.

## Type

- **Outfit** (OFL) 300–800 for UI. Title: 800, uppercase, tight leading (0.92), letter-spacing
  −0.5 px, accent line in `--cyan`. Body/controls 12.5 px / 500.
- **DM Mono** (OFL) 400/500 for every number, unit and key. Tabular figures.
- Labels: 9–10 px, uppercase, letter-spacing 0.12 em (mono) or 1.2 px (Outfit 600), `--mute`.
- Fonts are bundled locally (`@fontsource-variable/outfit`, `@fontsource/dm-mono`); nothing is
  loaded from a font CDN.

## Components

- **Stat chip:** label (mono 9 px uppercase, `--dim`) over value (mono 15 px, white). The "hot"
  chip shows its value in `--cyan`. Chips: Focus, Aperture, Sharp zone (+ readouts in M5).
- **Card:** glass background, 1 px `--line` border, 16 px radius, big soft shadow.
- **Segmented control:** track `#ffffff0c`, 2 px padding; buttons 28 px tall, 12.5 px Outfit 500,
  `#cfd6e8`; hover `#ffffff14`; **on** = `#eef4ff` background, `#101626` text. f-number segments
  use DM Mono.
- **Slider:** 2 px track `#ffffff1f`; fill gradient `#7fe3ff40 → --cyan` with a cyan glow; 16 px
  knob (light gradient, 3 px cyan halo); 1×5 px ticks; a translucent cyan **sharp-zone band**
  (`#7fe3ff2e` fill, `#7fe3ff66` border) showing the depth of field on the track. The distance
  slider is on a dioptre axis, so the band has constant width for a given lens and f-number.
- **Icon button:** 32 px square, `#ffffff12`, 14 px glyph; **on** = white with dark glyph.
- **Tooltip:** DM Mono 11 px, `#0b1020e0`, cyan 1 px border at 33% alpha, 9 px radius.
- **Explainer note:** small glass panel under the chips, 12 px / 1.5, key terms in white, focus
  terms in `--cyan`, warnings in `--amber`.
- **Dialog (how it works):** `#101526`, 20 px radius, 28 px padding, h2 23 px/700, h3 11 px
  uppercase `--mute`, `code` in DM Mono on `#ffffff12`.
- **Vignette:** left-edge darkening for title legibility plus an elliptical edge falloff.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│ FOCUS LAB              [Focus][Aperture][Sharp zone]  ┌card─┐ │
│ explainer note                                        │ ctl │ │
│                                                       └─────┘ │
│        3D bench in the forest (orbit, drag the ring)          │
│                                                               │
│                      ┌── viewfinder 3:2 ──┐                   │
└──────────────────────┴────────────────────┴───────────────────┘
```

Title and chips top-left, controls card top-right, viewfinder card bottom-centre. Under 900 px
wide: chips shrink, the controls card docks to the bottom and the viewfinder card sits above it.

## Interaction

Drag on empty space orbits, right-drag pans, scroll zooms. Dragging the focus ring or the distance
slider focuses (Option for fine control). Keys: subjects on number keys, `[` `]` nudge focus,
`V` viewfinder full screen, `R` reset view, `/` hide the interface, `Space` expose.

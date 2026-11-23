---
name: WasalX
description: The operator portal for WhatsApp and email customer service on top of a help desk.
colors:
  # Light theme (.theme-light). Dark values are in the Colors section. Source: app/design-system/tokens.css
  page: "#f7f7f8"
  sidebar: "#ffffff"
  surface: "#ffffff"
  surface-raised: "#f7f7f8"
  surface-selected: "#efeff1"
  border: "#e4e4e7"
  border-strong: "#cfcfd5"
  text: "#18181b"
  text-muted: "#696970"
  text-subtle: "#6f6f76"
  accent: "#6557d8"
  accent-strong: "#5141c8"
  accent-solid: "#6557d8"
  accent-solid-hover: "#5141c8"
  success: "#167d53"
  warning: "#a45e09"
  danger: "#c64343"
  on-solid: "#ffffff"
  provider-whatsapp-groups: "#16855a" # token --wx-color-provider-waha
  provider-meta: "#1769e0"
typography:
  heading:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.25
  body:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 550
    lineHeight: 1.25
  mono:
    fontFamily: "Geist Mono, ui-monospace, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
  arabic:
    fontFamily: "Noto Sans Arabic, sans-serif"
rounded:
  control: "0.375rem"
  panel: "0.5rem"
  dialog: "0.75rem"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "6": "1.5rem"
  "8": "2rem"
  "12": "3rem"
  "16": "4rem"
components:
  button:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "2.25rem"
    padding: "0 0.75rem"
  button-primary:
    backgroundColor: "{colors.accent-solid}"
    textColor: "{colors.on-solid}"
    rounded: "{rounded.control}"
    height: "2.25rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-solid-hover}"
  status-badge:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.dialog}"
    padding: "0.25rem 0.5rem"
  data-panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
  dialog:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.dialog}"
    width: "min(520px, 100%)"
---

# Design System: WasalX

The look-and-feel contract for the WasalX portal. It was derived on 2026-11-22 from main b67ab73: `app/design-system/tokens.css`, `primitives.css`, `primitives.tsx`, `app/globals.css` and the Storybook stories. It describes what ships today, not a redesign. Changes arrive through reviewed pull requests. When this file and the code disagree, the code is the fact and this file is updated.

## Overview

**Creative North Star: "The Quiet Control Room"**

WasalX is an Operate surface. Operators route WhatsApp and email conversations, manage groups and connections, and recover failed deliveries. The interface is a dense, calm, neutral workspace: zinc greys, one violet accent, thin borders, small type and almost no decoration. Status color carries meaning, and nothing else is colorful. Brand lives in precise details (the violet accent, Geist type, tight letter-spacing on headings), never in ornament.

The public pages (marketing, invitations, privacy) share the tokens but may be more expressive. The signed-in portal (`/app`, `/platform`) stays quiet.

**Key Characteristics:**
- Dark and light themes, chosen by the user or by `prefers-color-scheme` (`app/boundary-preferences.ts`); both are first-class.
- English and Arabic, with `dir` set on `<html>` from the locale (`app/layout.tsx`). Every layout must mirror correctly.
- Density over whitespace: 12-14 px working text, 34-36 px controls, tables as the main pattern.
- Tonal layering, not shadows, separates surfaces.

## Colors

One neutral zinc ramp, one violet accent, three status colors and two provider marks.

### Primary
- **Signal Violet** (light `#6557d8`, dark `#8c7cf4`; solid `#6557d8`/`#6d5ce7`): focus rings, links, selected state, the primary action. `accent-wash` (9-12 % violet) is for selected or focused fills.

### Neutral
- **Page / Sidebar / Surface / Raised / Selected**: light `#f7f7f8 / #ffffff / #ffffff / #f7f7f8 / #efeff1`; dark `#09090b / #0d0d0f / #111113 / #161619 / #1d1d21`.
- **Border / Border strong**: light `#e4e4e7 / #cfcfd5`; dark `#29292e / #3a3a42`.
- **Text / Muted / Subtle**: light `#18181b / #696970 / #6f6f76`; dark `#f3f3f5 / #92929d / #85858f`.

### Status and provider
- **Success / Warning / Danger**: light `#167d53 / #a45e09 / #c64343`; dark `#45c58a / #f3ad4e / #f06b6b`. Status color is always paired with a word or an icon, never color alone.
- **Provider marks**: WhatsApp groups green (`--wx-color-provider-waha`: `#16855a` light, `#22a06b` dark) and Meta blue (`--wx-color-provider-meta`, `#1769e0`). Use them only to identify a channel.

### Named Rules
**The One Accent Rule.** Violet is the only hue used for interaction. Any other color means status or provider.
**The Token-Only Rule.** New code uses `var(--wx-color-*)` (or the legacy `--bg/--surface/--text/...` aliases). No hex or `rgb()` outside `tokens.css`. `tests/design-system-governance.test.mjs` enforces this for primitives, and #184 tracks the cleanup of `globals.css`.
**The AA Rule.** Text and solid-action pairs meet 4.5:1 in both themes; the governance test checks it.

## Typography

**Latin:** Geist Sans / Geist Mono (local, pinned files). **Arabic:** Noto Sans Arabic (variable, `font-display: swap`), switched by `[lang="ar"]`.

**Character:** a neutral grotesk used small and tight: utilitarian, precise, never decorative.

### Hierarchy (tokens `--wx-font-size-1..7` = 12, 13, 14, 16, 20, 24, 32 px)
- **Heading** (650, 24 px, letter-spacing -0.03em): page and dialog titles.
- **Title** (650, 14-16 px, -0.015em): panel and section heads.
- **Body** (400, 13-14 px, line height 1.43; 1.6 for prose, max 45-65ch).
- **Label / table** (550, 12 px): table headers, badges, field labels, buttons.
- **Mono** (12 px): only for values an operator may copy (codes, references). Never for raw ids or internal names.

**The Scale Rule.** Use only the 7 size tokens. A raw `px` font size is drift (#184).

## Layout

- **Shell:** a fixed start-side sidebar (`--wx-sidebar-width` 15rem) plus the content area (`--wx-content-max` 90rem). The workspace toolbar is 57 px (`globals.css`); `--wx-topbar-height` (3.5rem) is used by the platform console.
- **At 760 px and below** (the shell breakpoint): the sidebar becomes a top bar with a menu toggle, the brand and system health are hidden, and the app shell is a block. Individual screens refine at other widths (for example 520 px and 480 px); new screens use 760 px unless their layout needs another.
- **Spacing:** `--wx-space-1..16` (4 px base: 4, 8, 12, 16, 24, 32, 48, 64). New code uses only these.
- **Direction:** logical properties only (`inline-start/end`, `padding-inline`, `text-align: start`). Physical `left/right` is a defect. A known gap: `primitives.css` `.wx-data-panel th, td` use `text-align: left`; fix this before the primitive is used in the product.
- **Tables:** 37 px headers, 57 px rows; wide tables sit in an `overflow-x: auto` wrapper and never scroll the whole page.

## Elevation & Depth

Flat with tonal layering: page → surface → raised → selected, separated by 1 px borders. New code uses only these two shadows; `globals.css` still has others (status glows, a layered dark-theme dialog shadow, the toast), tracked in #184:
- **Control** (`0 1px 1px var(--wx-color-control-shadow)`): the resting button.
- **Dialog** (`0 1.5rem 5rem var(--wx-color-shadow)`): dialogs and drawers only, over `--wx-color-overlay`.
In forced-colors mode, dialogs drop the shadow and use `CanvasText` borders.

## Shapes

Three radii: control 6 px, panel 8 px, dialog 12 px (also the pill radius of status badges). Borders are 1 px; `border-strong` is for controls. No thick one-side accent borders (detector `side-tab`, #184).

## Components

The target set is the primitives in `app/design-system/primitives.tsx` and `primitives.css` (Storybook "Foundation", "Controls", "OperationalStates"). The React primitives are used only in Storybook; the `.wx-button` classes already ship on some portal screens, and the rest of the portal uses the legacy `.button`, `.status` and table rules in `globals.css`. New screens use the primitives; legacy screens converge on them when they are touched.

- **Button** (`Button` / `.wx-button`): 36 px high, 12 px/550, control radius. Variants: `secondary` (the default, raised), `primary` (solid violet), `danger` (danger text plus a tinted border). It has a loading spinner, `disabled` at 0.56 opacity, and focus as a 2 px violet `outline` with a 2 px offset. **Drift:** legacy `.button` is 34 px high, and legacy `.button.primary` is inverted text-on-background (near-black in light, white in dark), not violet. Follow the primitive.
- **Status badge** (`StatusBadge` / `.wx-status`): pill, dot plus label, tones neutral/success/warning/danger.
- **Operational state** (`OperationalState`): one panel for loading (skeleton), empty, partial, fatal and recovery states, with a title, one plain sentence and at most one action. Every data view must have all of these states.
- **Data panel** (`DataPanel`): bordered panel with a header row and a table; sparse or dense density.
- **Dialog** (`ModalDialog.tsx`): at most 520 px, dialog radius, dialog shadow, scroll inside, focus trapped, Escape closes.
- **Toast**: bottom, inline-end, inverted colors, at most 520 px.
- **Inputs**: 34-38 px, raised background, `border-strong`; focus = violet border, a 3 px `accent-wash` ring and the shared 2 px violet outline (`Highlight` in forced colors). A field inside a container with its own focus ring (the search box) hides its outline except in forced colors; a danger field uses a danger-colored outline.

## Do's and Don'ts

- **Do** write all copy through `lib/i18n/messages/{en,ar}`; both catalogues keep the same keys (enforced by the `DictionaryFor` type and `tests/i18n-foundation.test.mjs`).
- **Do** write operator language: what happened and what to do next. **Don't** show internal or provider names (Zammad, WAHA, GOWS, Keycloak), raw ids, raw JSON, stack traces, HTTP codes or test words (#186).
- **Do** keep a visible keyboard focus on every interactive element in both themes and in forced colors. **Don't** remove an `outline` without an equivalent that survives forced colors.
- **Do** keep touch targets at least 44 px on coarse pointers: `@media (any-pointer: coarse)` sets a 44 px minimum on buttons, inputs, selects and text areas; keep that for new controls.
- **Do** respect `prefers-reduced-motion` (durations drop to 0, spinners and skeletons stop). Motion is 120-200 ms with the enter/exit eases.
- **Don't** add a hue, a shadow, a radius or a font size outside the tokens. **Don't** use gradients on working surfaces.
- **Do** show a mockup before any new screen; the Design lead approves it against this file.

## Speed

Speed targets for screens are defined in DELIVERY.md once agreed (#183). Until then, first-load and key-interaction timings are recorded on DEV as a baseline, without a pass/fail mark.

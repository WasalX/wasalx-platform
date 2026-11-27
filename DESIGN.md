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
  success: "#14744d"
  warning: "#965608"
  danger: "#b73737"
  danger-solid: "#7b2a2a"
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
  display:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3.75rem"
    fontWeight: 750
    lineHeight: 1.1
    letterSpacing: "-0.04em"
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
- Dark and light themes, chosen by the user or by `prefers-color-scheme` (`app/boundary-preferences.ts`); both are first-class. The root canvas (`html`) takes the active theme's page color, so overscroll and the area past the content never show the browser default.
- English and Arabic, with `dir` set on `<html>` from the locale (`app/layout.tsx`). Every layout must mirror correctly.
- Density over whitespace: 12-14 px working text, 34-36 px controls, tables as the main pattern.
- Tonal layering, not shadows, separates surfaces.
- Accessibility target: WCAG 2.2 AA on every screen, in both themes and both languages.

## Colors

One neutral zinc ramp, one violet accent, three status colors and two provider marks.

### Primary
- **Signal Violet** (light `#6557d8`, dark `#8c7cf4`; solid `#6557d8`/`#6d5ce7`): focus rings, links, selected state, the primary action. `accent-wash` (9-12 % violet) is for selected or focused fills.

### Neutral
- **Page / Sidebar / Surface / Raised / Selected**: light `#f7f7f8 / #ffffff / #ffffff / #f7f7f8 / #efeff1`; dark `#09090b / #0d0d0f / #111113 / #161619 / #1d1d21`.
- **Border / Border strong**: light `#e4e4e7 / #cfcfd5`; dark `#29292e / #3a3a42`.
- **Text / Muted / Subtle**: light `#18181b / #696970 / #6f6f76`; dark `#f3f3f5 / #92929d / #85858f`.

### Status and provider
- **Success / Warning / Danger**: light `#14744d / #965608 / #b73737`; dark `#45c58a / #f3ad4e / #f06b6b`. Each status badge keeps 4.5:1 text contrast on its 6% tint over every surface. Status color is always paired with a word or an icon, never color alone. **Danger solid** (`--wx-color-danger-solid`, light `#7b2a2a`, dark `#954242`) is the fill behind white text on a destructive button.
- **Provider marks**: WhatsApp groups green (`--wx-color-provider-waha`: `#16855a` light, `#22a06b` dark) and Meta blue (`--wx-color-provider-meta`, `#1769e0`). Use them only to identify a channel; the public pages' WhatsApp icon uses the WhatsApp groups green.

### Named Rules
**The One Accent Rule.** Violet is the only hue used for interaction. Any other color means status or provider.
**The Token-Only Rule.** New code uses `var(--wx-color-*)` (or the legacy `--bg/--surface/--text/...` aliases). No hex, `rgb()` or named color outside `tokens.css`; tints are `color-mix()` of a token. `tests/design-system-governance.test.mjs` enforces this for every `app/**/*.css` file except `tokens.css`.
**The AA Rule.** Text and solid-action pairs meet 4.5:1 in both themes; the governance test checks it.

## Typography

**Latin:** Geist Sans / Geist Mono (local, pinned files). **Arabic:** Noto Sans Arabic (variable, `font-display: swap`), switched by `[lang="ar"]`.

**Character:** a neutral grotesk used small and tight: utilitarian, precise, never decorative.

### Hierarchy (tokens `--wx-font-size-1..7` = 12, 13, 14, 16, 20, 24, 32 px)
- **Heading** (650, 24 px, letter-spacing -0.03em): page and dialog titles.
- **Title** (650, 14-16 px, -0.015em): panel and section heads.
- **Body** (400, 13-14 px, line height 1.43; 1.6 for prose, max 45-65ch).
- **Label / table** (550, 12 px): table headers, badges, field labels, buttons.
- **Right-to-left:** no letter-spacing on any text except codes; Arabic letters join.
- **Display** (750, `--wx-font-size-display` 60 px, -0.04em): the public-page hero only, fluid from 32 px.
- **Mono** (12 px): only for values an operator may copy (codes, references). Never for raw ids or internal names.

**The Scale Rule.** Use only the size tokens (the 7 steps, plus display for the public hero). A public heading may be fluid: `clamp(<token>, <token> + <n>vw, <token>)`. The governance test rejects any raw `px`/`rem` in a font size in any app stylesheet, also inside `clamp()`.

## Layout

- **Shell:** a fixed start-side sidebar (`--wx-sidebar-width` 15rem) plus the content area (`--wx-content-max` 90rem). The workspace toolbar is at least 57 px and grows with its text, so it never overflows onto the sidebar (`globals.css`); `--wx-topbar-height` (3.5rem) is used by the platform console.
- **At 760 px and below** (the shell breakpoint): the sidebar becomes a top bar with one grid (the workspace switcher on row 1, the menu toggle and profile on row 2, the navigation below), the brand and system health are hidden, and the app shell is a block. Individual screens refine at other widths (for example 520 px and 480 px); new screens use 760 px unless their layout needs another.
- **Spacing:** `--wx-space-1..16` (4 px base: 4, 8, 12, 16, 24, 32, 48, 64). **The Spacing Rule.** `padding`, `margin`, `gap` and `inset` and their longhands use only a defined `var(--wx-space-*)` step, `0` or a 1 px hairline (`calc()`, `max()` and `clamp()` of these, `%`, `vw`, `env()` and `auto` are fine). A negative offset is `calc(-1 * var(--wx-space-*))`. There are no in-between steps: snap to the nearest one, and on a tie take the smaller unless that drops a 44 px or 24 px target. Width, height and `min-*` target sizes are not spacing. The governance test enforces this for every app stylesheet.
- **Direction:** logical properties only (`inline-start/end`, `padding-inline`, `text-align: start`). Physical `left/right` is a defect. A known gap: `primitives.css` `.wx-data-panel th, td` use `text-align: left`; fix this before the primitive is used in the product.
- **Tables:** 37 px headers, 57 px rows; wide tables sit in an `overflow-x: auto` wrapper and never scroll the whole page. On phones (760 px and below) a table whose status or row actions would scroll off screen stacks each row instead, as Message delivery does (`.delivery-table`).

## Elevation & Depth

Flat with tonal layering: page → surface → raised → selected, separated by 1 px borders. Only these two shadows give elevation; the governance test enforces this for every app stylesheet. Rings without blur (`0 0 0 <width> <token color>`) are allowed for focus, status halos and 1 px edges:
- **Control** (`0 1px 1px var(--wx-color-control-shadow)`): the resting button.
- **Dialog** (`0 1.5rem 5rem var(--wx-color-shadow)`): dialogs and drawers over `--wx-color-overlay`, and the public pages' inbox showcase window.
In forced-colors mode, dialogs drop the shadow and use `CanvasText` borders.

## Shapes

Three radii: control 6 px, panel 8 px, dialog 12 px (also the pill radius of status badges). Borders are 1 px; `border-strong` is for controls. Radii in every app stylesheet use only these tokens (plus `0`, `inherit` and `50%` for circles). No thick one-side accent borders or inset side bars (detector `side-tab`); a selected row uses a full 1 px accent ring. The governance test checks both.

## Components

The target set is the primitives in `app/design-system/primitives.tsx` and `primitives.css` (Storybook "Foundation", "Controls", "OperationalStates"). The React primitives are used only in Storybook; the `.wx-button` classes already ship on some portal screens, and the rest of the portal uses the legacy `.button`, `.status` and table rules in `globals.css`. New screens use the primitives; legacy screens converge on them when they are touched.

- **Button** (`Button` / `.wx-button`): 36 px high, 12 px/550, control radius. Variants: `secondary` (the default, raised), `primary` (solid violet), `danger` (danger text plus a tinted border). It has a loading spinner, `disabled` at 0.56 opacity, and focus as a 2 px violet `outline` with a 2 px offset. **Drift:** legacy `.button` is 34 px high, and legacy `.button.primary` is inverted text-on-background (near-black in light, white in dark), not violet. Follow the primitive.
- **Icons** (`MarketingIcon` in `app/MarketingIcon.tsx`): 24 px line icons in `currentColor`, always `aria-hidden`. A button that starts with an icon, such as a plus on a create action, adds `.icon-action` so the icon sits at `--wx-icon-size-inline` (16 px) before its label. Never use a text glyph such as the fullwidth plus (U+FF0B); the app fonts have no glyph for it.
- **Status badge** (`StatusBadge` / `.wx-status`): pill, dot plus label, tones neutral/success/warning/danger.
- **Operational state** (`OperationalState`): one panel for loading (skeleton), empty, partial, fatal and recovery states, with a title, one plain sentence and at most one action. Every data view must have all of these states. While a lazy part of a panel, drawer or dialog loads, it shows the compact `SectionLoading` state ("Loading this section…"); `WorkspaceLoading` is only for whole views. Both are a plain `role="status"` region without `aria-busy`, and a slot that always loads beside another uses `quiet` so the text is announced once, unless the other slot's code is already loaded. A skeleton loader puts `aria-busy="true"` on the skeleton and announces through one plain `role="status"` text inside it, never a busy live region.
- **Data panel** (`DataPanel`): bordered panel with a header row and a table; sparse or dense density.
- **Dialog** (`ModalDialog.tsx`): at most 520 px, dialog radius, dialog shadow, scroll inside, focus trapped, Escape closes. Header, body and footer share one 16 px inline inset, and the header and footer dividers run edge to edge.
- **Scroll region** (`ScrollRegion` in `app/tenant-ui.tsx`): any area that scrolls on its own (wide table, drawer body, transcript) uses it; it requires a name (`aria-label` or `aria-labelledby`) and sets `role="region"` and `tabIndex={0}` so keyboard users can scroll it. `WideTable` wraps it.
- **Toast**: bottom, inline-end, inverted colors, at most 520 px.
- **Inputs**: 34-38 px, raised background, `border-strong`, body text size (14 px); a screen's fields share one field rule (Workflows and Client routing: the `.bot-automation`/`.routing-workspace` rule in `app/globals.css`); focus = violet border, a 3 px `accent-wash` ring and the shared 2 px violet outline (`Highlight` in forced colors). A field inside a container with its own focus ring (the search box) hides its outline except in forced colors; a danger field uses a danger-colored outline.

## Do's and Don'ts

- **Do** write all copy through `lib/i18n/messages/{en,ar}`; both catalogues keep the same keys (enforced by the `DictionaryFor` type and `tests/i18n-foundation.test.mjs`).
- **Do** write operator language: what happened and what to do next. **Don't** show internal or provider names (Zammad, WAHA, GOWS, Keycloak), raw ids, raw JSON, stack traces, HTTP codes or test words (#186).
- **Do** show an API error as catalogue text: `operatorFailureMessage` or `apiError` maps its code, with a translated fallback for unknown codes. **Don't** render or rethrow the API's own `error`, `message` or `safe_error` text, which is English only (#358, `tests/api-boundary-safety.test.mjs`).
- **Do** name a provider on a staff screen (the platform console) only where it labels that provider's figure, such as its capacity or usage counter. **Don't** name internal components there either: no control API, database identities or worker internals (#287).
- **Do** keep a visible keyboard focus on every interactive element in both themes and in forced colors. **Don't** remove an `outline` without an equivalent that survives forced colors.
- **Do** keep touch targets at least 44 px on coarse pointers: `@media (any-pointer: coarse)` sets a 44 px minimum on buttons, inputs, selects and text areas; keep that for new controls.
- **Do** respect `prefers-reduced-motion` (durations drop to 0, spinners and skeletons stop). Motion is 120-200 ms with the enter/exit eases.
- **Don't** add a hue, a shadow, a radius or a font size outside the tokens. **Don't** use gradients on working surfaces.
- **Do** show a mockup before any new screen; the Design lead approves it against this file.

## Speed

Page budgets for the portal. A miss becomes a board item.

| Measure | Budget | How it is measured |
| --- | --- | --- |
| `/app` first-load JavaScript | [Gzip and brotli byte limits](tests/app-first-load-js-budget.json) | Union of the client entry's dependencies and the static dependencies of every client reference `/app` renders, read from the production build's asset manifest (`dist/server/__vite_rsc_assets_manifest.js`); gzip level 9, brotli quality 11 (Node zlib); CI reports the measured bytes and enforces both limits in `tests/rendered-html.test.mjs` (#183, #213, #220) |
| Largest Contentful Paint (LCP) | Under 2.5 s at p75 | On DEV, per screen |
| Interaction to Next Paint (INP) | Under 200 ms at p75 | On DEV, per screen |

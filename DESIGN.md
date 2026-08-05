---
name: Mealio
description: Save a meal, and its ingredients land in your real grocery cart.
colors:
  brand: "#DD0031"
  brand-dark: "#B5002A"
  brand-light: "#FFF0F2"
  bg: "#FAFAF9"
  surface: "#F4F3F1"
  surface-raised: "#FFFFFF"
  border: "#E8E6E2"
  border-strong: "#D1CEC8"
  text-primary: "#18181B"
  text-secondary: "#52525B"
  text-tertiary: "#A1A1AA"
  success: "#16A34A"
  error: "#DC2626"
typography:
  display:
    fontFamily: "Pacifico_400Regular"
    fontSize: "28px"
    fontWeight: 400
    lineHeight: 1.1
  headline:
    fontFamily: "Inter_700Bold"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.25
  title:
    fontFamily: "Inter_600SemiBold"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Inter_400Regular"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter_500Medium"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "8px"
  input: "10px"
  button: "12px"
  card: "16px"
  pill: "20px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "#FFFFFF"
    typography: "{typography.title}"
    rounded: "{rounded.button}"
    padding: "12px 20px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.title}"
    rounded: "{rounded.button}"
    padding: "12px 20px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.brand}"
    typography: "{typography.title}"
    rounded: "{rounded.button}"
    padding: "12px 20px"
  button-danger:
    backgroundColor: "{colors.error}"
    textColor: "#FFFFFF"
    typography: "{typography.title}"
    rounded: "{rounded.button}"
    padding: "12px 20px"
  input:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    typography: "{typography.title}"
    rounded: "{rounded.input}"
    padding: "12px 14px"
  card:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.card}"
    padding: "16px"
  tag:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  tag-selected:
    backgroundColor: "{colors.brand-light}"
    textColor: "{colors.brand}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
---

# Design System: Mealio

## Overview

**Creative North Star: "The Quiet Countertop"**

A clean warm surface where the work happens. The interface is the counter, not the meal — it stays level, unhurried, and out of the way so the food can lead. Every chrome decision is made by asking what can recede. The one hot red in the system is the single live appliance in the room: you notice it because nothing else is competing.

This resolves what looks like a tension in the brief and isn't one. Mealio should feel **calm** and **appetizing** at the same time, and those pull against each other only if you try to make the chrome appetizing. It isn't the chrome's job. Warmth lives in the neutrals and appetite lives in the photography; the frame around them stays quiet. That division is load-bearing — a screen that gets more energetic by adding colour to its own furniture has broken the world, not extended it.

The system is also built for an unusual, slow scene. Add-to-cart runs live against a real grocery site, in the user's own session, and it can take minutes, hit a login wall, or partially succeed while the user watches. A design that shouts during a two-minute wait becomes exhausting. Calm here is not a style preference; it is what makes a long, fallible operation tolerable to sit through.

**Key Characteristics:**
- Warm paper surfaces, cool ink — a three-step warm neutral stack under a Zinc text ramp
- One accent, used rarely and only where a decision is being asked for
- A single type family (Inter) doing all the work, at five deliberate roles
- Flat resting surfaces with hairline borders; shadow is reserved for things that genuinely float
- Radius that grows with the element, from 10px inputs up to fully rounded pills
- Modal sheets, not stacked screens, as the dominant navigation move

## Colors

A warm paper stack under a cool ink ramp, interrupted by exactly one hot red.

### Primary
- **Signal Red** (`#DD0031`): The one action worth taking on a screen — the primary button, the selected tag's border, an active tab. Not decoration and never a surface wash. Its scarcity is the entire mechanism.
- **Pressed Red** (`#B5002A`): The darker press and hover state under Signal Red. Never a resting fill.
- **Blush** (`#FFF0F2`): The tinted fill behind a selected chip or an active row. The only place red is allowed to occupy area rather than a line or a label.

### Neutral
- **Warm Paper** (`#FAFAF9`): The app background. Every screen sits on this.
- **Countertop** (`#F4F3F1`): The recessed surface — secondary button fills, unselected chips, inset wells. One step *down* from the page.
- **Card White** (`#FFFFFF`): The raised surface — cards, inputs, sheets. One step *up* from the page. The three-step stack is how depth is made here; see Elevation & Depth.
- **Hairline** (`#E8E6E2`): The default border on cards, inputs, and chips. Does the structural work shadows do elsewhere.
- **Hairline Strong** (`#D1CEC8`): Emphasis dividers and the borders that must survive against Card White.
- **Ink** (`#18181B`): Primary text and headings.
- **Ink Muted** (`#52525B`): Secondary text, field labels, supporting copy.
- **Ink Faint** (`#A1A1AA`): Metadata, placeholders, timestamps, disabled text.

### Tertiary
- **Confirmed Green** (`#16A34A`): Success only — an item verified in the cart, a completed run. Never navigation, never decoration.
- **Alert Red** (`#DC2626`): Errors, destructive actions, invalid fields. **Deliberately distinct from Signal Red** — the brand red asks you to act, this one tells you something went wrong. Do not collapse them into one value; a destructive button and a primary button must not look the same.

### Named Rules

**The One Tap Rule.** Signal Red appears on exactly one element per screen: the single action the user is there to take. If a second red thing appears, one of them is wrong. This is what lets the eye find the button without the button being large.

**The Warm Paper, Cool Ink Rule.** Surfaces are warm-shifted (`#FAFAF9` → `#F4F3F1` → `#E8E6E2` → `#D1CEC8`); text is cool-shifted Zinc (`#18181B` → `#52525B` → `#A1A1AA`). The slight opposition is what gives the neutrals their newsprint quality. Never substitute a pure grey for a surface or a warm brown for text.

**The Two Reds Rule.** `#DD0031` means *act*. `#DC2626` means *something is wrong*. They are close enough to be confused and must never be used interchangeably.

## Typography

**Display Font:** Pacifico (with cursive fallback) — wordmark only
**Body Font:** Inter (400 / 400 italic / 500 / 600 / 700)

**Character:** Inter carries the entire product with almost no decoration — it is legible at 11px, neutral enough to disappear behind photography, and precise enough to make dense ingredient lists scannable. The script display face exists in exactly two places and is a logotype, not a typographic voice.

> **Note:** The display face is under active replacement (tracked as MEAL-66). It is documented here as the incumbent state, not as an invariant. The Inter body system is the durable part.

### Hierarchy
- **Display** (Pacifico 400, 28px, 1.1): The Mealio wordmark. Login and the Discover header. Nowhere else — 2 usages against Inter's 331.
- **Headline** (Inter 700, 20–28px, 1.25): Screen titles and the top of a sheet.
- **Title** (Inter 600, 16–18px, 1.35): Section headers, card titles, button labels, the selected state of a row.
- **Body** (Inter 400, 14–15px, 1.5): The workhorse. Ingredient names, descriptions, list content. 14px is the single most-used size in the app.
- **Label** (Inter 500, 12–13px, 1.4): Metadata, chips, field labels, timestamps, helper text.

### Named Rules

**The One Family Rule.** Inter does everything except the wordmark. Weight and size carry hierarchy; a new typeface never does. Adding a second text face to solve an emphasis problem is a failure to use the five weights already loaded.

**The Five Roles Rule.** Display, Headline, Title, Body, Label. Reach for a role, not a number. The codebase currently contains nine distinct sizes between 11px and 20px, which is drift rather than a scale — new work picks a role and stays in it.

## Layout

Single-column, full-bleed vertical scroll — the native phone default, and correct here because nearly every screen is a list of meals, ingredients, or stores.

**Spacing rhythm** is a 4px base with a strong preference for 8 / 12 / 16. Those three account for the large majority of all padding and margin in the app; 4 and 6 are for tight internal gaps (icon-to-label, chip padding), 20 and 24 for section separation. Screen gutters are 16px.

**Density is deliberately high in review contexts.** The pre-automation ingredient list and the reconcile queue put a checkbox, a name, one or more meal attributions, and a quantity stepper on a single row. That is correct: the user is auditing a list and needs to see many rows at once. Do not "breathe" these screens — the density is the feature.

**Modal sheets are the dominant navigational move**, not pushed screens. Six sheets (store selector, meal detail, filters, creator profile, product chooser, cart review) present as `pageSheet` with a slide transition. A new task-shaped surface should be a sheet unless it needs to persist across navigation.

## Elevation & Depth

**Depth is tonal, not cast.** The three-step neutral stack does the work: `#F4F3F1` recessed, `#FAFAF9` at page level, `#FFFFFF` raised. Hairline borders draw the edges. Shadow is almost absent by design and should stay that way.

The one genuine exception is the draggable cart-status bubble, which floats over arbitrary app content and needs a real shadow to separate from whatever is beneath it.

> **Decision recorded here rather than asked.** The `Card` primitive currently carries *both* a 1px border and a 5%-opacity shadow. That is redundant — at 5% opacity over a warm background the shadow is doing no visible work, and it costs a render layer. The rule below drops it. Plainly: on a countertop, things sitting on the surface don't glow; only things you're holding above it cast a shadow.

### Shadow Vocabulary
- **Floating** (`shadowOpacity: 0.22, shadowRadius: 6, offset: 0 2px, elevation: 8`): Elements that hover over unrelated content — the cart-status bubble, the draggable product preview. The only shadow the system needs.

### Named Rules

**The Countertop Rule.** A surface at rest is flat and bordered. Shadow means *floating above the app*, not *slightly important*. If an element cannot be dragged or does not overlay unrelated content, it gets a hairline, not a shadow.

**The One Depth Cue Rule.** Border or shadow, never both on the same element. Doubling them reads as heavy rather than raised.

## Shapes

Softly rounded throughout, with radius scaled to the element's size rather than applied uniformly. Nothing in the system is a hard 90° corner, and nothing is a squircle-adjacent extreme.

- **Inputs** — 10px. Tight enough to read as a field.
- **Buttons** — 12px. The most-repeated shape in the app.
- **Small surfaces** — 8px. Inline wells, notices, image thumbnails.
- **Cards and sheets** — 16px. The largest resting radius.
- **Chips and tags** — 20px, effectively a pill at their 26px height.
- **Avatars and the status bubble** — fully circular (`radius: size / 2`).

Borders are always **1px** at `Hairline`. The system has no 2px border and should not gain one; emphasis comes from `Hairline Strong` or from a fill, never from a thicker stroke.

### Named Rules

**The Softening Ladder Rule.** Radius grows with the element: 8 → 10 → 12 → 16 → pill. A 16px radius on a 32px-tall control is wrong in this system, and so is a 4px radius on a card.

## Components

### Buttons
- **Shape:** Gently rounded (12px), centered label, no border on filled variants.
- **Primary:** Signal Red fill, white Inter 600 label. `12px 20px` at default size; `8px 16px` small, `16px 24px` large. One per screen — see The One Tap Rule.
- **Secondary:** Countertop fill with a Hairline border and Ink label. The default for everything that isn't *the* action.
- **Ghost:** No fill, Signal Red label. For tertiary actions inside dense rows where a filled button would shout.
- **Danger:** Alert Red fill, white label. Destructive only.
- **Disabled / loading:** 50% opacity, interaction blocked. Loading swaps the label for a spinner — white on filled variants, Signal Red on secondary and ghost — so the button never changes size mid-action.

### Chips
- **Style:** Countertop fill, Hairline border, pill radius (20px), Ink Muted label at Inter 400 13px.
- **Selected:** Blush fill, Signal Red border *and* label, weight steps up to Inter 500. Selection is signalled three ways at once because chips are small and often scanned peripherally.

### Cards / Containers
- **Corner style:** 16px.
- **Background:** Card White on the Warm Paper page.
- **Border:** 1px Hairline.
- **Shadow:** None — see The Countertop Rule.
- **Internal padding:** 16px.

### Inputs / Fields
- **Style:** Card White fill, 1px Hairline border, 10px radius, `12px` vertical / `14px` horizontal padding. Label sits above at Inter 500 14px in Ink Muted.
- **Text:** Inter 400 **16px** — deliberately larger than body text, because anything smaller triggers iOS zoom-on-focus. Do not reduce it.
- **Error:** Border swaps to Alert Red, with a 12px message below in the same colour. The field keeps its fill; errors are drawn, not shaded.
- **Placeholder:** Ink Faint.

### Navigation
- **Bottom tab bar** as the app's spine. Active tab in Signal Red, inactive in Ink Faint.
- **Sheets over pushes.** Task-shaped surfaces arrive as `pageSheet` modals with a slide transition and a close control at top-left.
- **Hardware back must be honored on Android** for any dismissible overlay. A sheet that ignores it will dismiss the whole flow underneath instead.

### Meal Card (signature)
The unit the product is browsed in, and the one place photography leads.

A full-bleed image sits above a text body inside a 16px-radius Card White container. When a meal has no photo, a Countertop-filled placeholder carries a single 🍽️ glyph rather than a broken frame or a grey box. In selection mode a circular check overlays the image's top corner, filling with Signal Red when chosen.

**Discover leads with the photograph.** Image weight beats text weight on this card; names and tags support it. This is the one screen where appetite outranks density.

### Cart Status Bubble (signature)
A draggable circular puck that reports a running cart job while the user does something else. Card White fill, fully circular, the system's only Floating shadow, and a progress ring in Signal Red. It is the sole element permitted to sit over arbitrary content, and the sole reason the shadow vocabulary exists.

## Do's and Don'ts

### Do:
- **Do** put Signal Red on exactly one element per screen — the action the user came to take.
- **Do** build depth from the three-step neutral stack (`#F4F3F1` → `#FAFAF9` → `#FFFFFF`) plus a 1px Hairline.
- **Do** reach for one of the five type roles rather than inventing a size. Weight and size carry hierarchy; a second typeface never does.
- **Do** keep input text at 16px, always. Smaller values make iOS zoom the page on focus.
- **Do** present task-shaped surfaces as `pageSheet` modals with a slide transition, and dismiss them on Android hardware back.
- **Do** let ingredient and reconcile lists stay dense. The user is auditing a list and needs many rows visible at once.
- **Do** scale radius with the element: 8 → 10 → 12 → 16 → pill.
- **Do** render a Countertop-filled placeholder with a 🍽️ glyph when a meal has no photo, never an empty frame.

### Don't:
- **Don't** use Signal Red (`#DD0031`) and Alert Red (`#DC2626`) interchangeably. One means *act*; the other means *something is wrong*.
- **Don't** put a border and a shadow on the same element. The `Card` primitive does this today and it is the thing this document is correcting.
- **Don't** add a shadow to anything that can't be dragged or doesn't overlay unrelated content.
- **Don't** introduce a second text family to solve an emphasis problem — five Inter weights are already loaded.
- **Don't** substitute a pure grey for a warm surface, or a warm brown for the cool Zinc text ramp.
- **Don't** make the chrome appetizing. Warmth belongs to the neutrals and appetite to the photography; the frame stays quiet.
- **Don't** add new sizes between 11px and 20px. Nine already exist there, which is drift, not a scale.
- **Don't** use a 2px border for emphasis. Reach for Hairline Strong or a fill instead.
- **Don't** treat the Pacifico wordmark as an invariant — it is the incumbent state and is being replaced (MEAL-66). The Inter body system is the durable part.

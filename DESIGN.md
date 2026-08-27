---
name: warpline Board
description: A print shop bench for a plugin runtime — job tickets on a rail, galley proofs to read, stamps as the only verbs.
colors:
  ground: "#dfe2dc"
  ground-2: "#d3d7d0"
  sheet: "#fbfbf8"
  sheet-2: "#f1f1ec"
  ink: "#161614"
  ink-2: "#4b4c47"
  ink-3: "#5c5d58"
  rule: "#b7bbb3"
  rule-2: "#9a9e96"
  ticket: "#f3da66"
  ticket-ink: "#2b2405"
  ticket-ink-2: "#5a4c0a"
  pink: "#f2c3c6"
  pink-ink: "#5a1f24"
  red: "#c8102e"
  blue: "#1d4f9e"
  green: "#2f6b3a"
typography:
  display:
    fontFamily: "Archivo, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Archivo, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Archivo, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Archivo, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  proof:
    fontFamily: "'Source Serif 4', Georgia, 'Times New Roman', serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "Archivo, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "0.1em"
  stamp:
    fontFamily: "Archivo, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "0.07em"
    fontVariation: "'wdth' 112"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  sheet: "2px"
  stamp: "3px"
  pill: "999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
components:
  stamp-red:
    backgroundColor: "transparent"
    textColor: "{colors.red}"
    typography: "{typography.stamp}"
    rounded: "{rounded.stamp}"
    padding: "0.42em 0.6em 0.36em"
  stamp-blue:
    backgroundColor: "transparent"
    textColor: "{colors.blue}"
    typography: "{typography.stamp}"
    rounded: "{rounded.stamp}"
    padding: "0.42em 0.6em 0.36em"
  stamp-ink:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.stamp}"
    rounded: "{rounded.stamp}"
    padding: "0.42em 0.6em 0.36em"
  stamp-hold:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.stamp}"
    rounded: "{rounded.stamp}"
    padding: "0.35em 0.5em 0.3em"
  stamp-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.ink-3}"
    typography: "{typography.stamp}"
    rounded: "{rounded.stamp}"
    padding: "0.42em 0.6em 0.36em"
  ticket:
    backgroundColor: "{colors.ticket}"
    textColor: "{colors.ticket-ink}"
    rounded: "{rounded.sheet}"
    padding: "1rem 1rem 0.9rem"
  ticket-pink:
    backgroundColor: "{colors.pink}"
    textColor: "{colors.pink-ink}"
    rounded: "{rounded.sheet}"
    padding: "1rem 1rem 0.9rem"
  galley:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "0"
  note:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sheet}"
    padding: "0.9rem 1rem"
  hold-pill:
    backgroundColor: "transparent"
    textColor: "{colors.ticket-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.25rem 0.55rem"
  rail:
    backgroundColor: "{colors.ground-2}"
    textColor: "{colors.ink-2}"
    padding: "0.6rem 1rem"
  stream:
    backgroundColor: "{colors.sheet-2}"
    textColor: "{colors.ink-2}"
    typography: "{typography.mono}"
    padding: "0.9rem 1.2rem 1.1rem"
---

# Design System: warpline Board

<!-- Derived from the mock artboards at .impeccable/mocks/board/index.html (seed 77c5a08a), not from shipped product code. PRODUCT.md ## Stack records that the Board's production stack is undecided; re-run /impeccable document once the Board is implemented to reconcile these tokens with real code. -->

## Overview

**Creative North Star: "The Print Shop: Job Ticket and Galley Proof"**

The Board is a print shop bench. The page is stone-grey ground; everything on it is a piece of paper stock with a real job: a canary job ticket for every Ask waiting on the operator, a white galley proof for every Output a Plugin produced, a pink correction copy for a chore the operator has to do by hand. Verbs are literal rubber stamps (APPROVE, DENY, HOLD, CHOOSE, SEEN, DONE, CANCEL, RERUN, RUN NOW) in red or blue ink, and answering an Ask leaves an impression on the ticket. The one authored motion in the system is the stamp landing; the one ambient motion is the crawling ruled border on a running Run.

Density is a working bench, not a dashboard: dense metadata in condensed uppercase slug lines, body copy at 15px, proofs in a serif because they are meant to be read. The system refuses the sidebar-and-KPI-cards layout: there is no sidebar, no metric tile, no filled primary button. Light and dark are both first-class; dark is the same bench under worklight, with the same stocks at lower value and the stamp inks brightened to stay legible.

These tokens describe five mock artboards (Board, Ask, Output, Run, Plugin). The Board's production stack is not yet chosen (PRODUCT.md, Stack), so nothing here is bound to a framework; the values are what the artboards shipped.

**Key Characteristics:**
- Paper on stone: three stocks (sheet, ticket, pink) on a grey ground, each carrying a soft two-layer shadow
- Stamps are the only action verbs; there is no filled button in the product surface
- Two stamp inks, red and blue, are also the only two saturated colours in the palette
- One sans (Archivo, width axis used) for chrome and slug lines, one serif (Source Serif 4) for proof bodies, system mono for streams and timestamps
- Near-square corners (2px) everywhere except the stamp (3px) and the hold pill (999px)
- Dashed rules mean waiting or in-progress; solid rules mean settled

## Colors

Grey stone and paper stocks carry the whole surface; red and blue are stamp inks and appear as ink, borders and text, never as fills.

### Primary
- **Stamp Red** (`red`): the refusing or destructive verb (DENY, CANCEL), the critical count in the opening line, the current nav underline, focus outlines, text selection, failed status, declared side-effect chips, the "this plugin" node in the dependency graph, and expired-note borders. It is an accent by rarity; on the Board artboard it occurs on fewer than a dozen elements.
- **Stamp Blue** (`blue`): the sanctioning verb (APPROVE, RUN NOW), the running status, the emphasised span in the opening sentence, the stream cursor, and the "copied" flash. Blue means "allowed to proceed".

### Secondary
- **Canary NCR Ticket** (`ticket`, text `ticket-ink`, muted text `ticket-ink-2`): the job ticket stock. Every open Ask is this colour, whatever its kind. The ticket's own rules use black at low alpha (`rgba(0,0,0,.12)` and `.2`) rather than the grey rule tokens, so they read as printed on the stock.
- **Corrections Pink** (`pink`, text `pink-ink`): the chore ticket, an Ask whose work happens outside warpline. Same geometry as the canary ticket, different stock.

### Tertiary
- **Proof Green** (`green`): completed status only (done-lines and attempt rows). Never a fill, never a stamp.

### Neutral
- **Pressroom Stone** (`ground`): the page background and the artboard frame.
- **Bench Rail** (`ground-2`): the top navigation rail.
- **Galley Proof Stock** (`sheet`): every produced or informational sheet: galleys, notes, the run job sheet, the plugin spec sheet, and the on-press line.
- **Proof Stock, Second Sheet** (`sheet-2`): recessed panels inside a sheet: the log stream, `pre` blocks, inline code on notes, graph nodes.
- **Ink** (`ink`, `ink-2`, `ink-3`): body text, secondary text, and metadata/timestamps, in that order. `ink-3` is the floor for text on `sheet`.
- **Rule** (`rule`, `rule-2`): hairline dividers inside sheets (`rule`) and the stronger rail, dashed borders, and the ticket-rail bar (`rule-2`).

### Dark theme
The dark set is the same seventeen tokens at lower value (ground `#1b1c1a`, sheet `#272825`, ticket `#6b5c14`, pink `#6a3236`, ink `#ecebe3`) with the stamp inks brightened (red `#ff5468`, blue `#7ea6f0`, green `#7fc48c`) so they keep contrast on dark stock. Full values are in the sidecar. The mechanism is three-way: `:root` carries light, a `prefers-color-scheme: dark` block applies dark unless `[data-theme="light"]` is set, and `[data-theme="dark"]` forces it. `color-scheme` follows the theme so native controls match. Stamp impressions switch from `mix-blend-mode: multiply` to `screen` in dark.

### Named Rules
**The Two-Ink Rule.** Red and blue are stamp inks. They colour text, borders, outlines and impressions; they never fill a surface. The only exception is text selection, which is red ink on sheet.

**The Stock Rule.** What is waiting on the operator is on ticket stock (canary, or pink for a chore). What a machine produced or reported is on proof stock (sheet). The bench beneath is stone. A surface is one of those three; do not introduce a fourth.

**The Ink Floor Rule.** Text on any sheet is `ink-3` or darker; `rule` and `rule-2` are for lines only, never for type.

## Typography

**Display Font:** Archivo variable, weight 400–900, width 62–125% (with system-ui, Helvetica, Arial)
**Body Font:** Archivo for chrome and product copy; Source Serif 4 variable (weight 400 and 600, plus 400 italic; optical-size axis available) for proof bodies (with Georgia)
**Label/Mono Font:** system mono stack (ui-monospace, SF Mono, Menlo, Consolas) for streams, paths and timestamps

**Character:** A working grotesque that changes width to change job: condensed (80%) for slug lines and metadata, normal for copy, extended (112%) and black for stamps. The serif is reserved for text a person will actually read as a document. Numerals are tabular everywhere (`font-variant-numeric: tabular-nums` on body).

### Hierarchy
The scale is a hand-set ramp, not a ratio: 11 / 13 / 15 / 17 / 20 / 24 / 30 px (`--step--2` through `--step-4`). Base is 16px, dropping to 15px below 560px.

- **Display** (700, 30px, line-height 1, -0.02em): the waiting count in the opening line; and in serif at 600 for the full galley proof title.
- **Headline** (600, 24px, line-height 1.2, -0.02em): the critical ticket title, the full Ask ticket title, the plugin name on the spec sheet.
- **Title** (600, 17px, line-height 1.3, -0.01em): the standard ticket title. Info tickets drop to 15px. The opening sentence is 20px at 500, balanced, max 34ch. Galley proof titles are 20px serif 600.
- **Body** (400, 15px, line-height 1.5): product copy in Archivo. Proof bodies are serif at 15px / 1.45 in a galley and 17px in the full proof, max width 72ch. Secondary copy (meta, notes, done-lines, tables) is 13px.
- **Label** (700–800, 11px, 0.08–0.1em, uppercase): section heads (600, `ink-2`, 0.08em), ticket kind lines (800 on the bold part, 0.1em), galley slug lines (800 on the plugin name, width 80%, 0.06em), status words (800, 0.1em), definition-list terms and note headings (700, 0.1em, `ink-3`).
- **Stamp** (900, 13px, width 112%, 0.07em, uppercase, line-height 1): the verb vocabulary. Small stamps (HOLD, COPY) are 11px. The landed impression is 24px at 0.08em.
- **Mono** (13px, line-height 1.5): the log stream, inline code, home path (11px), timestamps and elapsed times.

### Named Rules
**The Width Axis Rule.** Archivo's width axis carries hierarchy that other systems give to colour: 80% for slug lines, 100% for copy, 112% for stamps. Do not introduce a second sans to get a condensed or extended voice.

**The Serif Is For Reading Rule.** Source Serif 4 appears only inside a proof body (galley `.proof`). Chrome, tickets, notes, tables and metadata are Archivo; tables inside a proof revert to Archivo at 13px.

**The Uppercase Is A Slug Rule.** Uppercase tracked type exists as slug lines, kind lines, status words, section heads and stamps: labels that name what a sheet is. It is never a decorative eyebrow above a prose heading.

## Layout

The product frame is a centred column, max 1280px, on the stone ground. Across the top is the bench rail (`ground-2`, 1px `rule-2` top and bottom): wordmark left, five place links (Board, Asks, Outputs, Runs, Plugins) at 13px with a 2px red underline on the current place, home path right in 11px mono. Below the rail, each place is a sheet area with `1.25rem 1rem 2rem` padding.

The Board place stacks three sections in a 1.5rem grid: the opening line (sentence left, waiting count right, 1px `rule-2` beneath), the ticket rail, the press, and the galleys. The ticket rail is an auto-fill grid (`minmax(270px, 1fr)`, 1rem gap) hung under a 6px `rule-2` bar; a critical ticket spans two columns. Galleys are the same grid at `minmax(300px, 1fr)` with a 1.25rem gap. The four detail places are two-column sheets: Ask `1.3fr / 1fr`, Output `1fr / 240px` with a sticky margin, Run `1fr / 280px`, Plugin `1fr / 1fr`, all at 1.5rem gap and aligned to start.

Spacing is loose bench rhythm in rem, not a strict grid: 0.25 / 0.5 / 0.6 / 0.75 / 0.9 / 1 / 1.25 / 1.5 / 2rem all occur. Sheet interiors pad `0.9–1.2rem` horizontally; ticket interiors `1rem`; section gaps `1.5rem`; the full ticket and spec sheet open up to `1.2–1.4rem`.

Two breakpoints. At 900px the two-column sheets collapse to one, the sticky margin goes static, and the critical ticket stops spanning. At 560px the base font drops to 15px, the opening line stacks and the waiting count inlines at 20px, the nav scrolls horizontally on its own row and the home path hides, the ticket and galley grids go single-column, the attempts table loses its time column to a second row, and the dependency graph SVG is replaced by a stacked list of levels.

Every grid child is allowed to shrink (`min-width: 0`) so `pre` blocks and tables scroll inside their sheet instead of breaking the column.

## Elevation & Depth

Depth is paper on a bench. Every sheet and ticket sits on the ground with a soft two-layer shadow at rest and lifts 2px with a deeper shadow on hover. Recessed panels (`sheet-2`) are tonal, not shadowed. Nothing casts a shadow on another sheet; the margin, the aside and the rail are flat.

### Shadow Vocabulary
- **Sheet at rest** (`box-shadow: 0 1px 2px rgba(20,20,18,.18), 0 6px 14px -8px rgba(20,20,18,.35)`): every ticket, galley, note, job and spec sheet. Dark theme: `0 1px 2px rgba(0,0,0,.5), 0 8px 18px -8px rgba(0,0,0,.7)`.
- **Sheet lifted** (`box-shadow: 0 2px 3px rgba(20,20,18,.18), 0 14px 24px -10px rgba(20,20,18,.45)` with `translateY(-2px)`): ticket and galley hover. Dark: `0 2px 3px rgba(0,0,0,.5), 0 16px 28px -10px rgba(0,0,0,.8)`.
- **Stamp relief** (`box-shadow: 0 3px 0 -1px rgba(20,20,18,.08)`): the rubber stamp at rest, an object with thickness. Hover: `0 6px 8px -4px rgba(20,20,18,.35)` with `translateY(-2px)`. Active: no shadow, `translateY(1px)`. Disabled: none.

### Named Rules
**The Paper Rule.** Soft shadows belong to stock: ticket, galley, note, job, spec. The stamp alone carries a hard relief because it is an object, not paper. Hard offset shadows appear nowhere else.

**The Dashed Means Waiting Rule.** A 2px dashed `rule-2` border marks a running Run; a 2px dashed `blue` border marks its status word; a dashed stroke in the dependency graph marks a Plugin waiting on a Grant; a dashed stamp border marks a disabled verb. Solid means settled.

## Shapes

Near-square. Every sheet, ticket, note, panel, code block and graph node has a 2px radius. The stamp and its impression have 3px so the double border does not pinch. The hold-duration buttons are pills (999px) and are the only round shape in the product surface; the theme toggle in the mock header is also a pill but is mock chrome.

Borders are hairlines (`1px` `rule`) inside sheets and stronger (`1px`–`2px` `rule-2`) at the edges of the bench and around waiting things. Stamps are `3px double currentColor` (2px for small stamps, 4px for the landed impression). Side-effect chips on the spec sheet are `1.5px solid red`. The ticket rail is a 6px bar with 3px rounded ends. The ticket's internal rules are black at 12–20% alpha, printed on the stock.

Rotation is a shape token here: every stamp sits at `-3deg`; the landed impression at `-8deg`; an answered ticket settles at `0.5deg` and 6px lower at 35% opacity.

## Components

### Stamps (the verb vocabulary)
Transparent, double-bordered, rotated -3°, uppercase black-weight extended Archivo. Every action in the product is a stamp; the word on it is the verb.
- **Shape:** 3px radius, `3px double currentColor`, `0.42em 0.6em 0.36em` padding, 13px; small variant 11px with a 2px border for HOLD and COPY.
- **Red** (`red`): DENY, CANCEL. The default stamp colour; the refusing verb.
- **Blue** (`blue`): APPROVE, RUN NOW. The sanctioning verb.
- **Ink** (`ink`): SEEN, CHOOSE, DONE, COPY, RERUN. Acknowledgements and neutral verbs.
- **Hold** (`ink-2`, small): HOLD 4H, HOLD 1D, HOLD 1W on a ticket.
- **Hover / Active:** lifts 2px with a soft shadow over `.18s cubic-bezier(.2,.9,.2,1)`; presses 1px with no shadow on active. Focus is the global 2px red outline, offset 2px.
- **Disabled:** `ink-3`, dashed border, no rotation, no shadow, 70% opacity, `not-allowed` cursor.
- **Impression:** on click the host receives an absolutely positioned 24px impression (`4px double`, -8°, 0.9 opacity, radial mask for uneven inking, `multiply` in light / `screen` in dark) in blue for a sanctioning verb and red otherwise; all stamps on the host disable; a rail ticket settles to its answered state after 900ms. The landing is the system's one authored motion: `land .22s cubic-bezier(.2,.9,.2,1)` from `rotate(-14deg) scale(1.5)` at 0 opacity to rest. Under `prefers-reduced-motion` the animation is removed and the impression simply appears.

### Tickets (Asks)
A job ticket: canary stock, a kind line, a title, metadata, what answering will do, and the verbs.
- **Corner Style:** 2px
- **Background:** `ticket` / `ticket-ink`; pink variant `pink` / `pink-ink` for a chore.
- **Shadow Strategy:** sheet at rest, lifted on hover.
- **Border:** none; internal rules `rgba(0,0,0,.12)`.
- **Internal Padding:** `1rem 1rem 0.9rem`, 0.55rem row gap; the full Ask ticket opens to `1.25rem 1.4rem 1.2rem` with 0.8rem gap.
- **Kind line:** 11px uppercase 0.1em in `ticket-ink-2`, the kind itself at 800 in `ticket-ink`, severity right-aligned at 700.
- **Severity scales the ticket:** critical spans two columns with a 24px title; standard is 17px; info is 15px.
- **Answered:** 35% opacity, `translateY(6px) rotate(.5deg)`, over `.5s`.
- **Decision options:** native radios with `accent-color: red`, 13px labels.

### Galleys (Outputs)
A proof hung to be read: a slug line, a serif body, a foot.
- **Corner Style:** 2px
- **Background:** `sheet` / `ink`
- **Shadow Strategy:** sheet at rest, lifted on hover.
- **Border:** none; slug and foot are separated by 1px `rule`.
- **Slug line:** `0.5rem 0.9rem`, 11px uppercase, Archivo at 80% width, 0.06em, `ink-2`; plugin name at 800 in `ink`; version note right in `ink-3`.
- **Proof body:** serif 15px / 1.45 in `0.9rem` padding, clipped at 16rem with a bottom fade (`mask-image: linear-gradient(#000 70%, transparent)`). The full proof drops the clip, sets 17px in `1.4rem 2rem` with a 72ch measure, a 30px serif title and 20px serif subheads, and shows a copy mark (`1.1rem` square, 2px `rule-2` border) in the left margin of each section on hover or focus.
- **Foot:** small ink COPY stamp left, link to the Run or Output right.

### Press lines (Runs on the Board)
- **On press:** a `sheet` row with a 2px dashed `rule-2` border and a 2px crawling ruled top edge (`repeating-linear-gradient(90deg, rule-2 0 8px, transparent 8px 16px)`, `crawl 1.2s steps(8) infinite`). Status word in blue, what it is doing in 13px, elapsed in mono.
- **Done line:** 13px row, 1px `rule` top, status word at 11px / 800 / 0.1em with a 6.5em column: green Completed, red Failed, `ink-3` Skipped; timestamp right in mono.

### Job sheet (a Run's page)
`sheet` with a band (status word in a 2px dashed blue border, title at 20px, started/elapsed in mono), an attempts list in a `5.5em 1fr auto` grid (status coloured green / red / blue / `ink-3`; a failed message is struck through in red), a mono stream on `sheet-2` (`0.9rem 1.2rem`, 13px / 1.5, `ink-2`, timestamps `ink-3`, highlights `ink`, a blinking blue `▍` cursor at `blink 1s steps(2)`), and a produced/raised section.

### Notes (margin cards)
`sheet` on `ink-2`, `0.9rem 1rem`, 13px, sheet shadow; heading 11px uppercase 0.1em `ink-3` at 700; definition lists in an `auto 1fr` grid. Expired variant: 2px red border and red heading. A note inside another sheet drops its shadow and sits on `sheet-2`.

### Hold pills
The only pill: `1px solid rgba(0,0,0,.28)`, 999px, `0.25rem 0.55rem`, 11px at 600, on ticket stock. Hover fills `rgba(0,0,0,.08)`; a disallowed duration is struck through at 45% opacity.

### Chips (side effects)
On the spec sheet, a declared side effect is `1.5px solid red`, red text, 11px uppercase 700 at 0.06em, 2px radius. "None" uses `rule-2` and `ink-3`.

### Navigation (the bench rail)
`ground-2` bar, 1px `rule-2` top and bottom, `0.6rem 1rem`. Wordmark at 600 / -0.02em; place links 13px `ink-2` with a transparent 2px bottom border that turns red and the text `ink` on the current place; no hover colour change. Below 560px the nav takes its own full-width row and scrolls horizontally.

### Dependency graph (the imposition)
An inline SVG on a sheet: nodes are `sheet-2` rects with a 1.5px `rule-2` stroke and 2px corners, 12px Archivo labels; the current plugin is a 2px red stroke; a plugin waiting on a Grant is dashed `4 3`; edges are 1.5px `rule-2` paths. Below 560px it becomes an ordered list of levels with the same stroke language as bordered spans.

### Links and focus
Links inherit colour, underline in `rule-2` with a 0.18em offset, and turn the underline red on hover. Focus-visible everywhere is a 2px red outline, 2px offset, 2px radius. Scrollbars are thin, `rule-2` thumbs with a 3px sheet-coloured inset.

## Do's and Don'ts

### Do:
- **Do** put every operator verb on a stamp; red for refusing, blue for sanctioning, ink for acknowledging.
- **Do** put anything waiting on the operator on ticket stock (`ticket`, or `pink` for a chore) and anything produced by a Plugin on proof stock (`sheet`).
- **Do** set proof bodies in Source Serif 4 and everything else in Archivo, using the width axis (80% slug, 112% stamp) for voice.
- **Do** keep corners at 2px on stock and 3px on stamps; the hold pill is the only round shape.
- **Do** mark waiting and in-progress states with dashed 2px rules, and a running Run with the crawling ruled edge.
- **Do** give every sheet the two-layer rest shadow and the 2px lift on hover; recess panels with `sheet-2` rather than an inset shadow.
- **Do** ship both themes: light on `:root`, dark under `prefers-color-scheme` and `[data-theme="dark"]`, with `color-scheme` set to match.
- **Do** collapse the stamp landing and the crawl under `prefers-reduced-motion`.

### Don't:
- **Don't** fill a surface with red or blue; they are inks for text, borders, outlines and impressions only.
- **Don't** add a filled or rounded button; stamps are outlined, rotated and double-bordered, and the hold pill is the only pill.
- **Don't** introduce a sidebar, KPI tiles or metric cards; the Board is a bench of tickets, press lines and galleys.
- **Don't** use a second sans, a condensed display face or an icon font; Archivo's width axis and inline SVG cover it.
- **Don't** set uppercase tracked type above a prose heading as decoration; uppercase is for slug lines, kind lines, status words, section heads and stamps.
- **Don't** set text in `rule` or `rule-2`; `ink-3` is the lightest text on any sheet.
- **Don't** use the retired nouns (dashboard, noticeboard, task board) anywhere on the surface; the objects are Plugin, Run, Output, Ask and Grant.

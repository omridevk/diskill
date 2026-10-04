# disk-clean: the action bar, and a design audit of every surface

Decided 2026-10-04. User, on the real page: "clicking clear selection or reset to recommended changes
the size of the bottom banner, also the buttons there are terrible, no way it went through any
audit; that bar at the bottom is awful". Confirmed from the screenshot:
- the bar changes height when the selection changes;
- "Clear selection" and "Reset to recommended" render as bare text, one grey (disabled), one
  white, with no button shape and no grouping;
- a long grey sentence runs off the edge and still describes the old holding folder.

## The action bar

- **Fixed height in every state:** idle, nothing selected, scanning, locked reasons, and the
  progress footer after approval. Changing the selection, a disabled reason or the button text
  never moves anything (tabular numbers, reserved widths, Text states swap for labels). A browser
  test asserts the bar's box is identical across states.
- **Layout, left to right:**
  - the selection summary: count and size (Number pop-in), with the section count secondary;
  - the selection tools as one compact group of shadcn `ghost`/`outline` icon buttons with
    tooltips and labels for assistive tech: Clear selection, Reset to recommended, Select all
    shown; each disabled state carries its reason in the tooltip;
  - a flexible gap;
  - Cancel (outline);
  - Delete (primary, the strongest element on the bar), with Delete immediately as its secondary
    (trash.md).
- **One line of help at most,** short and true to the current behaviour (Trash and undo, per
  trash.md). Details go into a small info popover, not a paragraph. Nothing truncates or wraps at
  the minimum window width; check 1024, 1280 and 1440 px.
- **Keyboard:** the shortcut hints sit in the tooltips (`D`, `R`, `A`) as `Kbd`.
- **Motion:** per motion-arrivals.md.

## Audit every surface

Run the impeccable skills on each surface, in order: `critique` (UX and hierarchy), `audit` (a11y,
contrast, theming, responsive), `polish` (alignment, spacing, consistency); plus
`fixing-accessibility` and `review-animations` where they apply. Then run `hallmark audit` (the
user's installed Hallmark skill) on each surface as the anti-AI-look pass: its punch list
(critical, major, minor) goes into the report, and every critical or major finding is fixed. Use
it as an audit plus its component-scope references (`interaction-and-states.md`,
`microinteractions.md`, `anti-patterns.md`), never its theme catalog, `redesign` or page flow:
this is a dense tool UI on shadcn and our tokens, not a landing page. Also run
`web-design-guidelines` (Vercel's Web Interface Guidelines) over every component and route file:
its `file:line` findings go into the report, and each one is fixed or answered with a reason.
Surfaces:
- header with tabs and status;
- summary strip;
- toolbar (search, filters, sort, view);
- sidebar sections;
- section header and table rows;
- cards view;
- warning banners;
- the action bar;
- confirm / Free / Empty dialogs;
- Details panel and log;
- Storage tab;
- Insights tab;
- not-found and error pages;
- the movie;
- the Trash view (trash.md).

For each surface, the report gives the findings table (before, after, why) and a before/after
screenshot pair in Chromium and Firefox at 1280 px. Everything uses shadcn components and the
existing design tokens: no new ad-hoc colors, spacing or radii.

## Known findings to fix in this pass (from the 2026-10-05 merge review)

- **Light theme:** the selected sidebar section uses a hard-coded dark background, so its title and
  size are dark on near-black and can't be read. All colours go through the theme tokens.
- **Risk filter vs the open section:** turning on "review" while a safe section is open leaves the
  open section out of the sidebar and shows "Nothing in this section matches these filters." The
  open section should follow the filter: open the first visible section, keeping the URL in sync.
- **Scan status:** the fixed status slot leaves a wide gap before Rescan when the text is short
  ("Scan complete"). Keep the slot stable without the stranded gap (Rescan inside the slot's line,
  or the slot sized to the longest real phase).
- **Typing headroom:** the per-keystroke flatness check passes on a quiet machine but fails at a
  load average around 10 to 40 (Chromium 21.6 vs 17.6 ms, Firefox p95 31.6 vs 18.8 ms). Trim the
  remaining plain-JS work per keystroke (`pickedOf`, `hidden`, the virtualizer re-measure) until
  it passes under that load too.

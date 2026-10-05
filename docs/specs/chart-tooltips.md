# disk-clean: chart tooltips you can use

Decided 2026-10-04 (user: "you can't really interact with the tooltip in the charts; every time I
try to click the popover it moves"). `CARD_TOOLTIP` (`components/chart-card.tsx`) anchors to the
pointer with `sticky: false`, so moving toward the card moves the card.

## The design: TanStack Charts' own pinned tooltips

Read `@tanstack/charts` 0.18 `docs/guides/tooltips-and-focus.md`, `interactions-and-selections.md`
("rich pinned tooltips", `pin: true`) and `accessibility.md` (pinned surface) first, and use what
they document. Don't build a popover of our own.
- **Hover:** a preview anchored to the datum, not the pointer, so it holds still while the
  pointer moves within that datum. It is display only: no buttons or links.
- **Click or tap a datum:** pins its tooltip. A pinned tooltip:
  - stays put and is interactive (copy path, open in Storage / Cleanup, any action it offers);
  - has the library's non-modal dialog semantics;
  - closes on Escape, an outside click, or clicking the datum again, and focus returns to the
    chart.
  Controls render only while `pinned` is true (accessibility.md).
- **Keyboard:** arrow keys focus datums, and Enter pins, as the library provides.
- On the Storage sunburst and treemap, a click currently zooms. Keep click as zoom and pin from
  the tooltip's own affordance, or make click pin with zoom as an action inside the pinned card.
  Whichever is chosen, the same rule applies across Storage and Insights. Record the choice
  here.
- Pinned state is transient UI, like an open popover, and stays out of the URL. Zoom stays in the
  URL as today (now a token, url-privacy.md).

## Tests (Chromium and Firefox)

- Hovering then moving the pointer to the tooltip keeps it open and in place.
- Click pins, the tooltip's controls work, and Escape closes it with focus back on the chart.
- Keyboard pin and dismiss work.
- Reduced motion is respected.
- No layout shift of the chart while a tooltip is pinned.

## Outcome (2026-10-04)

- **Choice: click pins, everywhere.** On every chart (Storage sunburst and treemap, the Insights
  charts, the disk donut) a click, tap or Enter pins the card, which is the library's own
  activation. Zoom moved into the pinned Storage card as a "Zoom in" link (in the treemap, "Zoom
  into <child>" when the tile is deeper than one level), next to "Copy path". `onSelect` no longer
  zooms. The hover hint says "Click to pin, then zoom in"; the side panel says the same.
- `CARD_TOOLTIP` (`components/chart-card.tsx`) is `anchor: 'point'` (the datum's centroid, so the
  preview holds still inside one datum) and drops `sticky: false`, so the library's pinning is on.
  `ChartCard` renders `actions` only while `pinned` (from `renderTooltipBody`), and every action
  calls the library's `dismiss` before it navigates. Pinned cards carry the library's non-modal
  dialog role; Escape, an outside click or a second click on the datum close them, and focus goes
  back to the chart.
- Actions: Storage folder card: Zoom in, Copy path. Insights folder-age card: Open in Storage (the
  `~/...` label expanded with the server's home folder), Copy path. Insights section card: Open in
  Cleanup. Calendar, file kinds and the donut have no actions; pinning them keeps the card still
  and its text selectable.
- **The hover-to-card test.** A transient card is display-only (`pointer-events: none`, inert body),
  so the pointer cannot rest on it; reaching it is what pinning is for. The test checks that the
  preview holds still while the pointer moves within a datum, and that a pinned card stays open and
  in place while the pointer moves onto it and elsewhere on the chart.
- **Tests.** `src/chart-tooltips.test.tsx` runs in Chromium and Firefox, and again in both with
  `prefers-reduced-motion: reduce` (the card shows with no running animation there, and animates in
  otherwise): hover anchoring, click pin with Copy path and Zoom in, Escape with focus back on the
  chart, outside click and second click, keyboard ArrowRight, Enter, Tab into the card and Escape,
  no layout shift while pinned, and Insights cards opening Storage and Cleanup.

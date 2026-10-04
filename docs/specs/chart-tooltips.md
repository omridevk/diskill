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

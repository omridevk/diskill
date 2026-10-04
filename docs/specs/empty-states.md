# disk-clean: one empty state, and it says the truth

Decided 2026-10-04. User screenshot mid-scan, at `/cleanup/docker` with "Only selected" on and
nothing selected. The page showed two messages at once:
- "Nothing matches these filters." with Clear filters, placed near the top;
- "Nothing is listed in “docker” yet; the scan is still running.", far below.

Causes in `components/cleanup.tsx`: `Body`'s empty branch still renders `children` (the open
section route, which renders `Unlisted`). Neither message knows the scan is running, and neither
knows the only filter on is "only selected" with an empty selection.

## Rules

- **Exactly one empty state at a time**, centred in the content area: never two stacked, never
  pinned to the top.
- **Pick the message by the real cause, in this order:**
  1. The scan is running and nothing has arrived yet (in this section, or at all): "Scanning… items
     appear here as they're found", with the shimmer from motion-arrivals.md. No action.
  2. "Only selected" is on and nothing is selected: "Nothing is selected", with "Show all items"
     (turns only-selected off).
  3. Other filters hide everything: "Nothing matches these filters", with Clear filters (clears
     the filters, keeps the selection). After a click, the page must visibly change.
  4. The scan is done and found nothing: "Nothing to clean up."
- A section that's in the URL but has no items yet while scanning shows message 1 for that
  section. After the scan finishes it's the router's not-found for a missing section, as today.
- Wording follows qa-round-2.md F. Every action must change what's shown; no dead buttons.

## Tests (Chromium and Firefox)

For each of the four causes: exactly one empty-state message is visible, it's the right one, and
its action works. Cover mid-scan with a section in the URL that has no items yet, and only-selected
with an empty selection during and after a scan.

## Cards view (second screenshot)

In cards view, the same section shows "Nothing matches these filters." with Clear filters, and below
it a large empty framed box (the `framed` SectionDetail, `h-[32rem]`) holding the "Nothing is
listed in “docker” yet" message. The rule is the same: one message, and no empty frame. The framed
section panel only renders when the section has rows to show.

## Warnings never move the page

User, on selecting a review item mid-scan: "the yellow banner appears after selection causing a
giant layout shift... why do you design stuff like that?" Today `Warnings` (hidden-selected,
risky-selected) inserts a full-width row between the toolbar and the content, so selecting one
item pushes the whole list down.
- Selection warnings live where the decision happens: in the action bar next to Delete, as a
  compact warning chip ("1 review item") inside the bar's fixed height (footer-and-audit.md: the
  bar never changes size). The detail goes in its tooltip or popover, and the confirm dialog
  repeats it. Nothing above the list appears or disappears because of the selection.
- Scan-level notices that aren't about the selection (scan problems, connection lost) use a
  reserved slot of fixed height, or Banner stacking (32) as an overlay that never pushes content.
- Test (Chromium and Firefox): the list's and the toolbar's boxes are identical before and after
  selecting a review item, after hiding a selected item with a filter, and after clearing both.

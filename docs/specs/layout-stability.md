# disk-clean: nothing moves unless the user moved it

Decided 2026-10-04. The user, on the real page: "awful, moves terribly... every change, layout
shift". Screenshots:
- the summary strip's legend (Used / Selected / Free) jumps up when the line
  "+ ≈13.7 GB apparent (Docker VM, clones), not counted" appears;
- the yellow selection banner pushes the list down (empty-states.md);
- the action bar changes height (footer-and-audit.md);
- the empty state sits at the top, half hidden (empty-states.md).
Fixing these one at a time is how we got here, so this spec is a rule for the whole page, plus a
test that enforces it.

## The rule

Streaming data, selection, filters, scan status and text changes never move a region or the
content inside it. Only the user's own layout actions may: switching view, opening a section,
opening a dialog or sheet, and scrolling.
- **Fixed slots.** Every line that can appear has its space reserved, or it lives in a slot that
  already exists:
  - the "≈ apparent, not counted" note;
  - scan status and its timer;
  - counts, sizes and the Delete label (tabular numbers, reserved widths);
  - the warnings (action bar chip, empty-states.md);
  - the hero numbers.
  If a line can't be reserved without wasting space, it moves into a tooltip or popover on
  something that is always there.
- **Anchored alignment.** Columns like the legend are top-aligned, never centred against content
  that grows. Text swaps happen in place (Text states swap, motion-arrivals.md).
- **Sidebar and lists:** new sections and rows arriving during a scan don't push the open
  section's header or the row the user is looking at. Insert below, or keep the viewport anchored.

## The guard (Chromium and Firefox)

A browser test drives one scripted session against the real page on a streaming sandbox scan:
the walk streams, items arrive, worktree checks resolve, a review item gets selected, a selected
item gets hidden by a filter, the risk filter is toggled, the selection is cleared and reset, the
apparent-size note appears, the scan finishes. After every step it compares the bounding boxes of
these landmarks with their first values:
- header, tabs, summary strip, donut, hero number, legend;
- toolbar;
- the list's top edge and the open section's header;
- the action bar and the Delete button.
Any change over 1 px fails, naming the landmark and the step. In Chromium it also records
`layout-shift` entries (PerformanceObserver) and fails on any shift not caused by user input.
The test runs in the normal `app` project, so every future change is held to it.

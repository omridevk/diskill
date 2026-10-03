# disk-clean: rescan from the review page

## Goal

A Rescan button on the review page runs the scan again without leaving the page. Everything the
user set up stays put (tab, List/Cards view, filters, search, sort, expanded sections, scroll,
selection); the results update in place as the new scan reports them. Decided 2026-10-03.

## Server (`review.rs`)

- `POST /rescan`, same token check as `/decide`. Answers 409 while a scan is running, 202 when it
  starts one.
- The rescan writes into the same run dir (scan.tsv, map.tsv, disk.tsv, insights.json are
  overwritten), so the command's stdout contract (`RUN_DIR` first line, `selection.json` second) and
  the skill are unchanged. `selection.json` is only ever written from the latest finished scan.
- Works in both modes: a live `review` and `review RUN_DIR` (finished run).
- The event log restarts: on rescan the stored events are replaced by a single `rescan` event and the
  new scan's events follow. Open `/events` streams notice the restart (a generation counter) and
  continue from the `rescan` event, so a connected page never receives the old scan twice; a
  reconnect or reload replays only the current scan.
- `elapsed_ms` restarts at 0 for the new scan.
- "Finished" state becomes resettable: `/preview` and `/decide approve` answer 409 again until the
  new scan's `done`; approval validates against the new scan only.
- Cancel (`/decide cancel`) during a rescan stops it, exactly as during the first scan.
- The "nothing found" auto-exit (code 3) applies to the first scan only. A rescan that finds nothing
  leaves the page open with an empty list.

| event | data | when |
| --- | --- | --- |
| `rescan` | `{elapsed_ms: 0}` | first event of every scan after the first |

## Page

- **Rescan** button beside the scan status line in the summary strip. Enabled when the scan is done
  or failed; disabled while scanning. A burning Approve fuse is undone when Rescan is pressed.
- On `rescan`: nothing is cleared. The summary keeps showing the current numbers (no "Scanning your
  disk…" headline, no flow-field backdrop: those are for the first scan only). The status line
  shows the new scan's phase and stopwatch ("Rescanning", then "Checking N worktrees"). Storage and
  Insights keep the previous map and charts until the new `walked` replaces them (no skeleton).
  Preview and Approve are disabled with the same reason as during the first scan.
- `item` events upsert by path as today. On `done`, items not reported since the `rescan` are
  removed, and sections left empty go away. Totals and the donut move through the existing
  transitions.
- Selection keeps the user's picks by path: an item the user deselected stays deselected when it
  comes back; a path that is new to this page arrives with its default preselection; removed items
  leave the selection.
- `disk` replaces the volume figures, `walked` replaces home, tree and insights.

## Also in this pass

- Tooltips on every chart (decided 2026-10-03): hovering a chart area shows a proper tooltip with
  that area's details, never a bare marker. The disk donut shows a dot on hover today and no
  details; it gets a tooltip per segment (Used / Selected to free / Free, formatted size and share
  of the disk). Every other chart (sunburst, treemap, calendar heatmap, folder-age heatmap, kinds
  bar, section idle heatmap) is audited the same way: the tooltip names the area in words (folder
  path, day, age bucket, kind) with formatted sizes and counts, no raw x/y values, styled with the
  existing dark tooltip vars.
- Rich tooltips (user, 2026-10-03: one-line "name · size · %" is useless; as much info as we can,
  and it must look great). A custom tooltip card (React, shadcn tokens, dark, entering with the
  existing tooltip transition), not the library's one-line text. For a folder (sunburst, treemap):
  - name as the title, full `~/` path under it (mono, middle-truncated);
  - size, share of its parent and of the disk, each with a thin proportion bar;
  - file count and newest modification ("changed 3 days ago");
  - its top 3 children as mini bars with sizes;
  - cleanable inside: bytes and item count of Cleanup items under this path, and how much of that is
    selected ("4.2 GB cleanable · 1.8 GB selected"), with the risk colour;
  - a hint line: "click to zoom".
  Rust adds what the page cannot know: each map node carries `files` (file count) and `mtime`
  (newest modification, unix seconds) from the walk, in map.tsv and the `walked.tree` event; the
  sizes test must still pass. Other charts get the same card style with their own details (day:
  bytes and files changed plus the largest folders touched if available; age bucket: folder, bucket,
  bytes, share of that folder; kind: bytes, files, share; section idle: section, bucket, items,
  bytes). Never the raw "(apparent sizes)" wording in a title; say what the number means. The
  hover dot marker goes away everywhere.
- The Preview button label vanishes after a click when the preview returns faster than the text
  swap (150ms): `useTextSwap` leaves `is-exit` on the element when the text flips back before its
  timer fires. Fix it in `useTextSwap` so every caller is covered, with a browser test.

## Tests

- Rust (`cli/tests`): `/rescan` with a bad token is 403; while scanning it is 409; after `done` it
  starts a scan, a stream connected across the restart sees `rescan` then the new scan's events and
  never the old ones again, `/preview` is 409 until the new `done`, and approval after it uses the new
  scan.tsv.
- Browser (vitest): after done, switch tab/view/filter and change the selection, press Rescan, feed
  `rescan` + items + `done` through the fake event source: view and filters unchanged, a deselected
  item stays deselected, an unreported item disappears at `done`, a new item arrives preselected per
  its default, Approve is disabled until `done`.

# disk-clean: the cleanup stays in the app

## Goal

After Approve the user stays in the review app and follows the real deletion there. Decided
2026-10-03 (user: "no way to go back, no way to see the real progress, we should show real progress
in the app, we should have a progress bar at the top of the app that the user can click and show
live progress of all the commands results streamed"). Default view = the app with progress; the
movie (`cleanup-movie.md`) is on demand only. Claude's dry-run step stays (user decision): Approve
hands back to Claude, which shows `clean --dry-run` in the terminal, then starts `clean`.

## Top progress bar

A slim bar pinned to the top of the app, present from the moment the fuse ends until the page
closes. It is a button (opens the progress panel) and it never covers content (the header moves
down by its height).

| state | bar shows |
| --- | --- |
| approved, worker not started | "Approved · Claude is showing the commands in your terminal" + an indeterminate shimmer |
| deleting | determinate fill by bytes; "Deleting · 4.2 of 23.4 GB · 87 of 203 · ~/Library/Caches/…" |
| done | full; "Freed 289 MB · 201 removed · 1 kept · 1 not removed" (amber/red counts when non-zero) |
| connection lost | "Reconnecting…" (EventSource retries; the replay makes it idempotent) |

The fill moves with `transform: scaleX`, never width.

## Progress panel

Opens from the bar (a sheet from the top or right, shadcn Sheet; Escape and outside click close it;
focus returns to the bar). Live, newest first, streamed from the worker events:

- Header: freed so far (count-up), items done / total, elapsed, the real free space before → now.
- One row per event: removed (path, size, seconds), not removed (path, reason, red), worktree kept
  (path, reason, amber) or removed, command (label, ok / failed). Each row has its time.
- Filter chips: all / removed / problems / commands. The list is virtualized or capped so 10k rows
  stay smooth.
- A "Watch the movie" button that opens the film as a full-screen overlay (Escape / close return
  to the app, progress continues). Its shader renders at half resolution and only while open.

## The rest of the app during and after the cleanup

- Cleanup list: each approved row shows its live status (queued, deleting, removed struck through
  and dimmed but listed, kept amber + reason, not removed red + reason); section headers show
  "12 of 43 removed". Unapproved rows dimmed, checkboxes disabled.
- Summary: "Selected to free" becomes "Freed" with the running figure; donut and "free after" use
  the real `free` samples.
- Locked after approval: Approve, Preview, Rescan, selection. A new cleanup goes through
  `/disk-clean` again.
- Storage and Insights stay browsable.

## Cancel

Cancel gets the same undo window as Approve (the fuse), so a misclick no longer ends the session.

## Reload-safe

`watch` also serves `GET /` rendered from the run dir (the `finished_run` data `review RUN_DIR`
uses) plus `approved: true` and the selection, so a reload during or after the cleanup lands back in
the app with the bar and panel. Everything else about `watch` stays read-only.

## Bugs to fix in this pass

- The film's shader froze during the Waiting act in the user's Zen (screenshot 2026-10-03). Root
  cause first (canvas loop `running`, timeline paused, or the tab-visibility path), then fix.
- The removal of the film's full-page approve exit, the full-resolution shader, the per-frame text
  writes and the low-contrast Deleting cards per the review-animations findings (Block).

## Performance budget

60 fps in the user's Zen during a 200-item deletion with the panel open: events applied once per
animation frame, only changed rows re-render, no full-screen shader unless the movie is open.

## Tests

Browser: approve (bar shows the hand-back state), feed the cleanup events: bar progress and text,
panel rows with reasons and filters, per-row statuses in the list, locked controls, Cancel undo,
movie opens and closes with progress continuing, reload restores the bar and panel. Rust: `watch`
serves `/` with `approved: true`. Sandbox end-to-end must set `HOME` to its resolved real path
(`pwd -P`, i.e. `/private/var/...`), since a symlinked HOME makes `clean` reject every path as
protected.

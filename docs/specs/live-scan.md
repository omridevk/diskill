# disk-clean: live scan in the review page, faster walk

## Goal

The review page opens the moment the user runs the skill. The scan runs in the background and the
page fills in as results arrive. The walk itself gets faster by reading directories in bulk.

Decisions (2026-10-02): particle text on the loading screen; items stream as they are found;
bulk directory reads land in the same lane.

## Command shape

- `disk-clean review` with no run dir: create the run dir (same naming as `scan`), start the page
  server, open the browser, run the scan on a background thread, stream it to the page.
- `disk-clean review RUN_DIR` keeps working for a finished run: everything is replayed at once and
  the page starts in the done state.
- `disk-clean scan` stays (CI, scripting, tests). Both paths share one scan function that reports
  through a sink; `scan` uses a sink that only writes files.
- On exit `review` prints the run dir on stdout (first line) so the skill can pass it to `clean`.
  Exit codes unchanged (0 approved, 3 nothing found, 4 timeout, 5 cancelled).
- The skill collapses stages 1 and 2 into one `review` call (run in the background by Claude, the
  page is the progress UI). `clean --dry-run` and `clean` are unchanged.

## Event stream

`GET /events?token=<token>` returns `text/event-stream` (token in the query because EventSource
cannot set headers; wrong token is 403). The server keeps every event it has emitted; a new
connection first receives all of them in order (a reload resumes), then live ones.

| event | data | when |
| --- | --- | --- |
| `disk` | `{total, used, free, snapshots}` | immediately (statfs, tmutil) |
| `progress` | `{files, bytes, dir}` | during the walk, at most 10 per second |
| `item` | `{category: {id, title, desc, risk}, item: <Item as today>}` | when a scan row is final |
| `walked` | `{home, tree, insights}` | walk finished (map, home size, insights) |
| `done` | `{reclaimable}` | scan.tsv, map.tsv, disk.tsv, insights.json written |
| `error` | `{message}` | scan failed; page shows it, nothing can be approved |

Rows that only exist after the walk (worktree checks, docker/brew/simulator probes) arrive as
`item` events after `walked`, each as soon as it is known. `progress` stops after `walked`.

`/preview` and `/decide` with `approve` answer 409 until `done`. `/decide` with `cancel` works at any
time and stops the scan thread. Validation is unchanged: `selection()` and `clean` still accept only
paths that are in the finished `scan.tsv`.

The initial HTML keeps the JSON data script, now holding only `{"live": true}` (or the full data for
a finished run) plus the token meta.

## Page

- Loading screen until the first `walked`: ParticleText (React Bits, MIT + Commons Clause; keep its
  notice in the copied file) drifting around "Scanning your disk…", with the live counter
  (files, bytes, current folder) under it. On `walked` the particles gather into the reclaimable
  total so far, then the normal layout fades in. Reduced motion: static text, no particles.
- Items stream into Cleanup as `item` events arrive (sections appear, totals and the donut update
  through the existing transitions). Preselected items arrive selected.
- Until `done`: a slim status line in the summary ("Checking 168 worktrees…"), Preview and Approve
  disabled with a reason.
- Storage and Insights show a skeleton until `walked`.
- Scan status line: React Bits Lattice Loader (no deps) with the current phase verb and its
  stopwatch ("Walking disk", "Checking 168 worktrees"), resolving to a check on `done` or a cross
  on `error`.
- Approve: React Bits Fuse Button replaces the two-click confirm. Pressing Approve starts an undo
  window (fuse burning, label "Undo", Escape undoes); `/decide approve` is sent only when the fuse
  runs out. Swap its Hugeicons for lucide. Reduced motion: static countdown text.
- One Radiant shader (MIT, radiant-shaders.com, WebGL or Canvas 2D, picked by the user) as the
  loading-screen backdrop behind the particle text only; paused when the tab is hidden, a static
  frame under reduced motion, removed once the layout fades in.
- Connection lost: reconnect with EventSource defaults; the replay makes it idempotent (items keyed
  by path).

## Faster walk

Replace per-entry `symlink_metadata` in `walk.rs` with `getattrlistbulk(2)` per directory
(ATTR_CMN_NAME, OBJTYPE, DEVID, FILEID, MODTIME, plus ATTR_FILE_ALLOCSIZE / ATTR_FILE_LINKCOUNT),
keeping today's accounting exactly: allocated blocks, hard links counted once, same pruning and
classification, same totals as `du -skx` (`tests/sizes.rs` must still pass unchanged). Measure on the
real machine before and after (release build, whole volume) and report both.

## Out of scope

Cancelling a scan from the terminal, resuming a half-finished scan across processes, Linux.

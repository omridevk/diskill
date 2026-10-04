# disk-clean: delete like Finder (Trash, with undo)

Decided 2026-10-04 (user: "do it like finder, delete and shift delete or command delete will skip
mac trash, but we can still keep a db of the files in trash locally and make sure it is always in
sync so we can have undo in our UI as well"). Replaces the holding folder of hold-and-confirm.md:
numbered folders plus a JSON manifest under `~/.cache/disk-clean/held` were unreadable in Finder.

## Two ways to delete, like Finder

- **Delete** (default button, ⌘⌫ anywhere but a text field, ⌫ or Delete while focus is in the item
  table) moves each approved path to the macOS Trash
  through the system API (`NSFileManager trashItemAtURL:resultingItemURL:error:`), which handles
  per-volume `.Trashes` and name clashes and returns where the item landed. No Finder/Apple Events
  automation prompt. Called from Rust without a new crate: one `osascript -l JavaScript` (JXA, ObjC
  bridge) per batch, paths in through stdin as JSON and results out as JSON; a new crate needs the
  user's approval first. Verify on this macOS whether Finder's "Put Back" works for items trashed
  this way and record the answer here; our own Undo never depends on it.
- **Delete immediately** (a secondary "Delete immediately…" button; ⌥⌘⌫ like Finder, and ⇧⌫ in
  the app) skips the Trash, removes for good, and is labelled "can't be undone" everywhere. Its
  confirm is stronger (exact counts and bytes, the button names the action, no default focus on
  it).
- Worktrees and the three fixed commands stay "can't be undone" as today; they are never trashed.
- Every safety rule stays: only scanned paths, canonical, allowed, re-resolved right before the
  move or removal, symlinks moved or removed themselves and never followed.

## The record (our "db" of what we trashed)

- `~/.cache/disk-clean/trashed.jsonl`, appended before each trash call and completed after:
  `{run, original, trashed, bytes, at, dev, ino, state}`. State is one of:
  - `trashed`;
  - `restored` (our Undo);
  - `put-back` (the user did it in Finder);
  - `emptied` (gone from the Trash);
  - `failed` (with a reason).
- **Sync**, on every `disk-clean` command and every page load: for each `trashed` entry check that
  the trashed path still exists with the same dev/ino (still trashed). If not:
  - the original path exists with the same inode: `put-back`;
  - neither exists: `emptied`;
  - otherwise: a reason. Never act on a mismatch.
- **Undo** moves the item from its trashed location back to the original path (same-volume rename,
  never overwrites; if the original exists again it stays in the Trash with a reason), per item,
  per run or all.
- **Empty these** removes only our recorded, still-trashed items from the Trash, after a confirm.
  It never empties the whole Trash and never touches items we didn't put there.

## The app

- A **Trash** view (route `/trash`, tab next to Insights) lists every item we put in the Trash, from
  the record after sync, across runs: original path (`~`), size, when, run. It offers Undo or
  "Empty these" per item, per run and for the selection; emptied and put-back items show as such.
- After approval the progress, header, summary and footer say "Moved to Trash X · undo available"
  (no expiry: the Trash is the user's), with Undo and "Empty these from Trash".
- Every state (selected rows, filters, open run) is in the URL; data comes from TanStack DB
  collections fed by the server; no effects; errors shown at the action with Retry.

## Migration

The holding folder goes away:
- On the first run after this ships, every existing held run is moved to the Trash item by item
  through the same API, recorded as `trashed` with its run, and the holding folder is deleted
  once empty.
- `DISK_CLEAN_HOLD_DAYS`, expiry, the `free` command, `/free`, the "Held by disk-clean" section and
  the hold wording are removed.
- `undo` stays (it now restores from the Trash), and a new `empty` command plus `/empty` replace
  `free` (token, Host/Origin and record-only scope as today).
- SKILL.md is updated to match.

## Tests

- **Rust:**
  - trash moves the right paths and records them;
  - a name clash in the Trash is handled;
  - undo restores exactly and never overwrites;
  - sync detects put-back, emptied and replaced items;
  - empty removes only recorded items;
  - delete immediately removes and is never recorded as undoable;
  - migration moves held runs to the Trash;
  - symlink and parent-swap attacks are kept.
  The trash tests run against a real Trash on a RAM disk volume (its own `.Trashes`), never the
  user's `~/.Trash`.
- **Browser (Chromium + Firefox):** the Trash view, Undo and Empty per item, run and selection, the
  delete-immediately confirm and its shortcuts, URL state, and errors with Retry.

## Outcome (2026-10-05)

- **The move.** `trash.rs` sends each batch of up to 64 paths to one `/usr/bin/osascript -l
  JavaScript` call (through `util::spawn`), paths in on stdin as JSON, `{trashed}` or `{error}` per
  path out as JSON. JXA's `Ref()` out-parameter crashes osascript (exit 139) for
  `trashItemAtURL:resultingItemURL:error:`; `$()` works and is what the script uses. Name clashes
  come back renamed by the system (`a 01-20-21-770`), symlinks are moved themselves, and concurrent
  callers trashing the same name each get their own name. Right before the call each path is
  re-checked (`safe_to_remove`), lstat'ed for dev/ino and appended to the record as `failed:
  interrupted` (so a crash mid-call is never silent); after the call the landed path must be a direct
  child of `~/.Trash` or `<volume>/.Trashes/<uid>` with the same dev/ino, or the entry stays failed
  and nothing else is done with it. Items already inside a Trash are removed for good, never trashed
  again.
- **The move race.** The system call takes a path, so the item is re-identified right before its own
  call: the script lstats each path (`attributesOfItemAtPath`, which does not follow a final symlink)
  and moves it only if its dev/ino still match what Rust recorded, else answers "it changed after the
  check". That shrinks the window from a whole batch plus the osascript start to the microseconds
  between that lstat and `trashItemAtURL` for the same item. Residual guarantee: if a parent is
  swapped to a symlink inside that window, the swapped target lands in the Trash (recoverable with
  Put Back) and the entry is reported failed ("moved, but replaced"); it is never deleted. Cost on
  200 items on a RAM disk, batches of 64: 0.35 to 1.04 s before, 0.39 to 1.06 s after (three rounds
  each, noise larger than the change); batches of 1 instead would take 27.1 s. The script stays under
  800 bytes (a compile-time check): on this Mac `osascript` launched from a non-shell parent is
  SIGKILLed at exec when its arguments pass about 915 bytes.
- **Migration failures.** A held item is renamed to its original name before the Trash call; if the
  call fails it is renamed back to its number (no-follow, never overwriting). Held items are found by
  manifest path or by original name, both checked by dev/ino, so an item left under its readable name
  (a failed rename back, or a crash between the rename and the call) is still found and moved on the
  next run. The manifest and run folder are removed only when nothing but the manifest, its tmp and
  the lock is left in the folder; a read-only folder (as in Go's module cache) is the real case where
  the rename works and the Trash refuses. Under three test processes trashing same-named items at once, the system refused about 1
  in 15 runs one item ("couldn't be moved to the trash") while its siblings moved; items it refuses
  that are still at their original path are retried once in a second call (18 of 18 runs green after
  that).
- **Put Back.** Yes, on this macOS (Darwin 25.6): after `trashItemAtURL` the Trash folder's
  `.DS_Store` holds the `ptbL` (original folder) and `ptbN` (original name) records for the item,
  which is exactly what Finder's Put Back reads. Verified on a RAM disk volume by reading the
  `.DS_Store` bytes, not by clicking Put Back in Finder (no Finder automation was used). Migrated
  held items are renamed to their original name inside the holding folder before trashing, so Put
  Back on those points at the old holding folder, which no longer exists; our Undo restores them to
  the real original path.
- **The record.** `~/.cache/disk-clean/trashed.jsonl`, entries `{id, run, original, trashed, bytes,
  at, dev, ino, state, reason}` (16-hex `id`, `run` is the run directory's name plus a hash), last
  line per id wins, rewritten atomically after each batch. One lock (`trashed.lock`) is held by the
  worker for all its moves, and by undo, empty, sync and migration, so only one of them touches the
  record at a time (the hold-era race between Undo and the worker). Sync runs on every command
  (except `watch` and the worker, which sync and tell the page) and on every page load, and emits a
  `trash` event with the changed rows to the page.
- **Routes.** `/undo` and `/empty` take `{token, ids}` on both the review server and the watch
  helper, need the page's own Origin and Host, act only on recorded `trashed` ids (404 otherwise,
  409 while the record is busy), run synchronously and answer with the changed rows, which the page
  writes into its `trash` collection; the job's events still stream for progress. `/free` is gone.
- **The page.** One `phaseOf(scan, progress)` (scanning, reviewing, waiting, trashing, deleting,
  trashed, undoing, emptying, finished, stopped) drives the header line, hero label and number, the
  counter row (the scan counter becomes the cleanup's own counter after approval), the status slot
  (the scan loader becomes the cleanup status) and the free-space line, which never says "was X, now
  X". The `/trash` tab lists the record across runs (virtualized), with `run` and `pick` in the
  search and `/trash/empty?target=` for its confirm.
- **Tests.** Rust tests run on a per-process APFS RAM disk (`common::ram_root`, detached at exit):
  `common::bin` refuses a HOME outside it and the helpers check every recorded path is inside it.
  Browser: `trash.test.tsx` (Chromium and Firefox) and the stability guard's new approval and
  Trash-view sessions.

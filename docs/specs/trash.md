# disk-clean: delete like Finder (Trash, with undo)

Decided 2026-10-04 (user: "do it like finder, delete and shift delete or command delete will skip
mac trash, but we can still keep a db of the files in trash locally and make sure it is always in
sync so we can have undo in our UI as well"). Replaces the holding folder of hold-and-confirm.md:
numbered folders plus a JSON manifest under `~/.cache/disk-clean/held` were unreadable in Finder.

## Two ways to delete, like Finder

- **Delete** (default button, Delete key in the list) moves each approved path to the macOS Trash
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

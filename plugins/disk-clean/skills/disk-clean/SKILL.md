---
name: disk-clean
description: Find reclaimable disk space on this Mac, show a browser UI listing exactly what will be deleted, and run the approved cleanup in the background (approved items are held first, so it can be undone until they are freed). Use when the user asks to clean up disk space, free space, find what is eating the disk, or invokes /disk-clean.
---

# Disk Clean

Scan and review (stages 1 and 2) run as one command, then stage 3 deletes. Never skip the review — nothing is deleted without an explicit approval in the UI.

Every stage goes through one launcher. It runs the `disk-clean` binary for this plugin version,
fetching it on first use (the published release, checksum-verified, or a `cargo build` from the
bundled source when no release exists). The first run may print a download or build line on stderr.

## Stages 1 and 2 — Scan and review

Run this **in the background** (`run_in_background: true`) and tell the user to switch to the
browser tab that opens: the page is the progress UI, so the terminal will look idle.

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" review
```

It creates a run directory under `~/.cache/disk-clean/`, opens a local page in the default browser
right away, and scans in the background while the page fills in: a live counter during the walk
(one to three minutes, a single parallel walk of the data volume), then the cleanup list, storage
map and insights, then the git worktree checks and Docker/Homebrew/simulator probes. Delete
works while the scan is still running: every item already on screen can be deleted. Worktree rows
and the Docker and simulator command rows show "checking…" in place of their checkbox until their
check answers. Confirming Delete during the scan stops it and approves what was found so far. The
command **blocks** until the user confirms Delete or Cancel. When it exits, the **first line of stdout is `RUN_DIR`**; on approval a second line is the
path of `$RUN_DIR/selection.json`. Read `RUN_DIR` from the background task's output before stage 3.

The run directory holds `scan.tsv` (cleanable items, appended as each one is listed on the page,
so an approval made mid-scan is validated against exactly what was shown; rows still being checked
are never in it), `map.tsv` (size tree), `disk.tsv` (volume
totals, snapshot count, and `too_deep`: folders nested too deep to read, also reported on stderr),
`insights.json` (home files by modified day, age per folder, kind, and the largest files), and on
approval `selection.json`.

`HOME` is resolved to its real path once at startup and that path is used everywhere (scan, map,
safety rules, clean); when it differs (a symlinked home) the resolved path is printed on stderr.
Every command refuses to run with an empty, relative or missing `HOME`.

Tunable via environment variables: `DISK_CLEAN_MIN_BYTES` (default 10 MB floor per item),
`DISK_CLEAN_STALE_DAYS` (default 90), `DISK_CLEAN_BIGFILE_BYTES` (default 1 GB),
`DISK_CLEAN_OLD_DOWNLOAD_DAYS` (default 180), `DISK_CLEAN_MAP_DEPTH` (default 5),
`DISK_CLEAN_MAP_MIN_BYTES` (default 200 MB), `DISK_CLEAN_NM_DEPTH` (default 9),
`DISK_CLEAN_NM_MIN_BYTES` (default 5 MB), `DISK_CLEAN_SKIP_MAP=1` to skip the storage map
and walk only the home and temp folders instead of the whole volume, `DISK_CLEAN_HOLD_DAYS`
(default 7) for how long approved items stay held before they are freed automatically.

The page has three tabs, a summary strip (disk donut, selected total, scan status) and a footer:

- **Cleanup** — sections grouped Safe / Review first / Report only, as a **List** (sidebar of
  sections plus a table of the open section) or **Cards** (one card per section). Each section has a checkbox for all its shown items, and its size and counts follow
  the filters (a path inside another selected path counts once). Live search, risk filters
  (safe / review / report only), minimum-size and minimum-idle filters, sort (size, natural name
  order, age), only-selected, and keyboard shortcuts (`/` search, `a` select shown, `d` deselect
  all, `r` reset, `v` switch view). Sections with more than three items get a quick-select row —
  **all N · idle 90+ days · idle 1+ year · none**. Banners warn when selected items are hidden by a
  filter and when anything marked `review` is selected.
- **Storage** — read-only. A **sunburst** or **treemap** of the whole data volume (click to zoom in,
  breadcrumbs to go back up, white outlines mark folders the Cleanup tab can delete), an inspector
  for the hovered folder, and the reconciliation of the whole disk (home folder + rest of the data
  volume + macOS system volume and APFS reserve + free = total). This is where the space this skill
  *cannot* reclaim shows up.
- **Insights** — read-only charts: bytes by last-modified day over the past year, the age of the
  largest folders under `~`, bytes by file kind, cleanup sections by idle time, and the largest files.
- **Addresses** — everything you see is in the page address, so reload, Back/Forward and a copied
  link all restore it: the tab and the open section or zoomed folder are the path
  (`/cleanup/<section>`, `/storage/<folder path>`, `/insights`), filters, sort, view and the
  chart shape are query parameters (default values are left out), the Delete confirm is
  `/cleanup/<section>/confirm`, the Free confirm is `/cleanup/<section>/free`, and the progress log
  and the movie are `?overlay=progress` / `?overlay=movie`. The ticked items are in the address too:
  `add` and `drop` hold only the changes from the recommended selection. Escape closes a dialog by
  going back to the address it was opened from. The local server answers every page address with
  the same page and token.
- **Clear selection** and **Reset to recommended** (footer, beside the "N items selected · X"
  count) do what the `d` and `r` shortcuts do. Each is disabled only when it would change nothing,
  and then its name says why. They are hidden while a cleanup runs.
- **Delete N items · X** (footer): enabled whenever at least one selected item can be deleted,
  also while the scan runs. When it cannot be pressed its label says why: "Scanning… nothing found
  yet", "Select items to delete", "Nothing found to delete" or "The scan failed · nothing can be
  deleted". It opens a confirm dialog (Escape or Cancel closes it and changes
  nothing) built by the same validation code `clean` uses: the totals, then **Moved to hold (undo
  available)** with every path and its size, **Can't be undone** with the exact command lines (git
  worktree removals, freeing an earlier held run, the fixed commands), and anything the safety
  checks rejected with the reason. While the scan is still running it also says "The scan is still
  running; confirming stops it and uses what was found so far.", and it approves exactly the list it
  shows, even if more items arrive while it is open. Its button ("Move N items to hold", or "Delete N items" when
  nothing can be held) sends the approval; there is no countdown after it. **Cancel** (end the
  session without deleting) still has a few-second undo window.
  After approval the page stays on the review app with a progress bar at the top: first "Claude is
  showing the commands in your terminal" (the dry run below), then the real cleanup once stage 3
  starts (items done, current path), then the result. Held items are labelled "held, not freed yet":
  the bar, the summary and the footer say "Held X · not freed yet · undo until <date>" and offer
  **Undo** (puts every held item back exactly where it was) and **Free the space now** (deletes the
  held items for good after its own confirm). Only Free, worktree removals and freeing earlier held
  runs count as freed; the volume's free-space change is shown separately and labelled "free space
  changed by" (other apps write to the disk too). If `clean` never runs, finds nothing that passes
  the safety checks, or its worker dies, the bar says the cleanup did not start (or stopped) and
  why. Clicking the bar opens a live log of every held item, removal, kept worktree, failure (with
  its reason), command, undo and free; the cleanup list marks each approved row as it goes. A
  "Watch the movie" button there plays the cleanup film on demand; it ends on what was held (with
  Undo / Free) and plays its "You freed" payoff when Free completes. A reload keeps the bar and log.
  A small helper keeps serving the page after `review` exits; its only actions are Undo and Free for
  this run's own held items, and it stops on its own a minute after the tab is closed or the
  cleanup finished.

Exit codes: `0` approved (`$RUN_DIR/selection.json` written), `3` nothing found,
`4` timed out after 30 minutes, `5` cancelled or empty selection.
On any non-zero exit, stop and report — do not delete anything.

## Stage 3 — Background cleanup (hold first)

To print the plan without changing anything (same validation, same commands). It lists the hold
moves (`mv -- '<path>' '<held path>'`) under `# moved to hold`, separately from the steps under
`# can't be undone` (git worktree removals, freeing earlier held runs, fixed commands):

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" clean --dry-run "$RUN_DIR"
```

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" clean "$RUN_DIR"
```

Returns immediately with a pid and a log path. The cleanup runs detached: each approved path is
first resolved again, then moved (an instant same-volume rename that never follows symlinks) into
`~/.cache/disk-clean/held/<run>/<n>` and recorded in that folder's `manifest.jsonl`; a path that
cannot be moved there (another volume, permission) is reported `NOT HELD` and left where it is.
Worktrees, earlier held runs and the fixed commands run afterwards and can't be undone. Only one `clean` runs per run directory at a time. Exit codes (the dry run uses the
same ones): `0` queued, `2` no run directory / `selection.json` / `scan.tsv`, `3` nothing passed the
safety checks (see `$RUN_DIR/rejected`), `4` another `clean` is already running for this run
directory. Check progress with:

```bash
tail -20 "$RUN_DIR/clean.log"; cat "$RUN_DIR/status" 2>/dev/null
```

`status` reads `pending` while running, `done` when finished, `interrupted` if the worker died
before finishing, and `abandoned` when nothing passed the safety checks or `clean` was never run
after the approval. The tail of the log reports `removed: N items, X bytes` (what was freed), `held: N items, X bytes,
not freed yet (undo until <date>: ...)` and, separately, how much the volume's free space changed
since the worker started. Each run starts a
fresh `$RUN_DIR/clean.events`; the review tab shows the current run live from it, so the user can
watch it there instead of waiting on the terminal.

### After approval: report, undo, free, expiry

When `status` is `done`, tell the user what happened in these words: **"held X (undo available
until <date>)"**, plus anything removed, kept or not held, taking X and the date from the `held:`
line of `clean.log`. Holding frees no space yet; never call held bytes freed.

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" undo "$RUN_DIR"
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" free "$RUN_DIR"
```

- `undo` moves every held item of that run back to its original path. If something exists at the
  original path again (for example `node_modules` was reinstalled), that item stays held and the
  output says why; it never overwrites. Undo after a partial free restores what is still held.
- `free` deletes the held items of that run for good (four at a time) and reports what was freed.
  Only run it when the user asks to free the space; it can't be undone.
- Both act only on the entries of that run's manifest, re-check each held copy before touching it
  (a held copy that was replaced, or a manifest entry outside its holding folder, is left alone and
  reported), and print `restored:` / `freed:` and `still held: N`. Exit codes: `0` done, `2` no run
  directory, `3` nothing is held for that run, `4` the held items are busy (another undo, free or
  clean). The review page offers the same two actions and shows their progress live.
- Expiry: held runs older than `DISK_CLEAN_HOLD_DAYS` (default 7) are freed automatically by the next
  `disk-clean` command of any kind, before it does anything else; it says so on stderr.

## What the scan covers

**Held by disk-clean** is its own section: one row per held run (age and size). The holding folder
is never part of the other sections. Selecting a run and approving frees it (can't be undone).

**node_modules is its own section**, listed by project directory, with the package manager and
days-since-install on every row, at any age (5 MB floor, searched 9 levels deep). Only entries
older than 90 days are preselected — the rest are one click away via the section quick-select.
This matters: a working machine can hold tens of GB of *fresh* node_modules that an
age-based rule never surfaces.

Deletable, preselected: Trash, `~/Library/Caches`, `~/Library/Logs` and crash reports,
package-manager download caches (npm, pnpm, yarn, bun, pip, uv, Homebrew, go-build, cargo,
Playwright, Puppeteer, CocoaPods, Electron), Xcode DerivedData / simulator caches /
device support, unavailable simulators, and build artifacts untouched for 90+ days
(`.venv`, Cargo `target`, `.next`, `.turbo`, `.svelte-kit`, `__pycache__`).

**Sizes are labelled by how they were measured.** Anything the walk measured directly (allocated
blocks, hard links counted once, the same accounting as `du -skx`) counts toward
the headline "reclaimable" figure. Two things do not, and render with a `≈` instead:
`docker system prune` reports space *inside* Docker's sparse VM disk image, which does not shrink
— pruning frees it for Docker but returns little or none of it to macOS (to get that back, reset
the Docker VM disk from Docker Desktop). The unavailable-simulator estimate is a rough guess.
The UI keeps these out of the main total and shows them separately as "+ N GB inside Docker's VM".

Deletable, **not** preselected: the pnpm content store (existing `node_modules` hard-link into
it, so clearing it breaks every checkout until reinstall), package-manager extracted stores
(`~/go/pkg/mod`, `~/.m2`, `~/.gradle/caches`, `~/.cargo/registry/src`, `~/.gem`), Xcode
Archives, iOS device backups, Docker prune.

Excluded on purpose: toolchain roots (`.nvm`, `.volta`, `.asdf`, `.pyenv`, `.rbenv`, `.local`)
are never treated as stale build artifacts — their `node_modules` hold globally installed CLIs.

Report only, never deletable through this skill: files over 1 GB outside `~/Library` (measured
by blocks actually allocated, so sparse disk images report their real footprint, not their
apparent size), and `~/Downloads` entries older than 180 days. They are shown with disabled
checkboxes so the user can act on them manually.

**Git worktrees**. Finds every repo under `$HOME` (6 levels deep,
`DISK_CLEAN_REPO_DEPTH`) and every worktree it has registered, wherever that worktree lives
(including `/private/tmp` scratchpads). A worktree is offered for removal only when ALL of these hold:
clean `git status` including untracked files, not locked, no process has its cwd inside, no
merge/rebase/cherry-pick/revert/bisect in progress, no submodules, no worktree-only refs, on a
named branch (or a detached HEAD some ref contains), no commit in its HEAD reflog that no
branch/tag/remote/stash holds, and every git-ignored file is known build output (`node_modules`,
`dist`, `.turbo`, caches, ...). Anything else, such as `.env`, `.idea` or plan folders, keeps it. Idle for
`DISK_CLEAN_WORKTREE_IDLE_DAYS` (default 2) means preselected. Everything else is listed report-only
with the reason. Removal re-runs every check per worktree, then calls `git worktree remove` without
`--force`, so git itself refuses anything dirty. Only the folder goes. The branch and all commits
stay, and `git worktree add <path> <branch>` restores it. The safety tests live in the plugin's
`cli/tests` and run with `cargo test`.

## Safety rules

- `clean` moves or deletes a path only if it appeared in that run's `scan.tsv` (the record of every
  item the page was shown, written as each one is listed). The UI cannot smuggle
  in an arbitrary path. Duplicate selections run once.
- Paths must be canonical: anything with `//`, a `.` or `..` component, or a trailing `/` is
  rejected, never normalised.
- Hard-blocked regardless of selection: `$HOME` itself and every folder above it, anything outside
  `$HOME` other than `/private/tmp` entries and the per-user `$TMPDIR` tree, and
  `Documents`, `Desktop`, `Pictures`, `Movies`, `Music`, `.ssh`, `.gnupg`, `.aws`, `.kube`,
  `.claude`, `Library/Mail`, `Library/Messages`, Keychains (names matched case-insensitively). These
  protections apply even when `$HOME` itself lives inside the temp folders. Rejects land in
  `$RUN_DIR/rejected`.
- Right before each removal (files, folders and worktrees alike) the path is resolved again: its
  parent's real path plus its name must still equal the scanned path, and that path must still be
  allowed. A path whose parent was swapped for a symlink after the scan is kept and logged `KEPT`
  with the reason. A symlink is removed itself, never followed.
- Only three shell commands can ever run, by fixed id: `xcrun simctl delete unavailable`,
  `docker system prune -f` (dangling only, never named volumes), `brew cleanup --prune=all -s`.
- Worktrees are never deleted directly: they are only removed with `git worktree remove`
  after a fresh re-check. A worktree that changed after the scan is kept and logged as `KEPT`.
- The review page and its helper answer only requests addressed to `127.0.0.1:<port>` or
  `localhost:<port>`; changes also need a JSON body from the page's own origin and its token. The
  helper's only changes are Undo and Free (`POST /undo`, `POST /free`), which also require the page's
  `Origin` and act only on that run's held items.
- No `sudo`, ever. System-level caches under `/Library` and `/private/var` are out of scope.
- Approved paths are moved to the holding folder first, never deleted directly, so the cleanup can
  be undone until they are freed (by Free, or automatically after `DISK_CLEAN_HOLD_DAYS`). Freeing is
  permanent, not to the Trash. Git worktree removals and the three fixed commands can't be held and
  are labelled "can't be undone" everywhere.

## Re-running

Each run gets its own directory under `~/.cache/disk-clean/`. Old run directories are kept for
audit and are safe to delete. To re-open the UI for a completed scan without rescanning, pass the
run directory: `review "$RUN_DIR"` (it starts in the finished state and prints only the
`selection.json` path on approval). `scan [RUN_DIR]` still runs the scan alone, without a page.

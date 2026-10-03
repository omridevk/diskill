---
name: disk-clean
description: Find reclaimable disk space on this Mac, show a browser UI listing exactly what will be deleted, and run the approved deletion in the background. Use when the user asks to clean up disk space, free space, find what is eating the disk, or invokes /disk-clean.
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
map and insights, then the git worktree checks and Docker/Homebrew/simulator probes. Preview and
Approve unlock when the scan is done. The command **blocks** until the user clicks Approve or
Cancel. When it exits, the **first line of stdout is `RUN_DIR`**; on approval a second line is the
path of `$RUN_DIR/selection.json`. Read `RUN_DIR` from the background task's output before stage 3.

The run directory holds `scan.tsv` (cleanable items), `map.tsv` (size tree), `disk.tsv` (volume
totals and snapshot count), `insights.json` (home files by modified day, age per folder, kind, and
the largest files), and on approval `selection.json`.

Tunable via environment variables: `DISK_CLEAN_MIN_BYTES` (default 10 MB floor per item),
`DISK_CLEAN_STALE_DAYS` (default 90), `DISK_CLEAN_BIGFILE_BYTES` (default 1 GB),
`DISK_CLEAN_OLD_DOWNLOAD_DAYS` (default 180), `DISK_CLEAN_MAP_DEPTH` (default 5),
`DISK_CLEAN_MAP_MIN_BYTES` (default 200 MB), `DISK_CLEAN_NM_DEPTH` (default 9),
`DISK_CLEAN_NM_MIN_BYTES` (default 5 MB), `DISK_CLEAN_SKIP_MAP=1` to skip the storage map
and walk only the home and temp folders instead of the whole volume.

The page has three tabs, a summary strip (disk donut, selected total, scan status) and a footer:

- **Cleanup** — sections grouped Safe / Review first / Report only, as a **List** (sidebar of
  sections plus a table of the open section) or **Cards** (one card per section); the view is
  remembered. Each section has a checkbox for all its items. Live search, risk filters
  (safe / review / report only), minimum-size and minimum-idle filters, sort (size, name, age),
  only-selected, and keyboard shortcuts (`/` search, `a` select shown, `d` deselect all, `r` reset,
  `v` switch view). Sections with more than three items get a quick-select row — **all N · idle 90+
  days · idle 1+ year · none**. Banners warn when selected items are hidden by a filter and when
  anything marked `review` is selected.
- **Storage** — read-only. A **sunburst** or **treemap** of the whole data volume (click to zoom in,
  breadcrumbs to go back up, white outlines mark folders the Cleanup tab can delete), an inspector
  for the hovered folder, and the reconciliation of the whole disk (home folder + rest of the data
  volume + macOS system volume and APFS reserve + free = total). This is where the space this skill
  *cannot* reclaim shows up.
- **Insights** — read-only charts: bytes by last-modified day over the past year, the age of the
  largest folders under `~`, bytes by file kind, cleanup sections by idle time, and the largest files.
- **Preview commands** (footer) — a dry run. Shows the exact shell commands Approve would run for the
  current selection (`rm -rf -- '<path>'`, `git -C <repo> worktree remove <path>`, the fixed
  commands), plus anything the safety checks reject. Nothing runs; the list is built by the same
  validation code `clean` uses. Worktree safety checks are not repeated here; `clean` re-runs them
  right before each removal.
- **Approve and delete** (footer) — starts a few-second undo window (a burning fuse; Undo or Escape
  cancels). The approval is sent only when the window runs out. The page then stays open and shows
  the cleanup as it happens once stage 3 starts: each item leaving the disk, the reclaimed total and
  free space from real measurements, anything kept or not removed with its reason, and a summary of
  what was actually freed at the end. A small read-only helper keeps serving the page after `review`
  exits; it never deletes anything and stops on its own a minute after the tab is closed or the
  cleanup finished.

Exit codes: `0` approved (`$RUN_DIR/selection.json` written), `3` nothing found,
`4` timed out after 30 minutes, `5` cancelled or empty selection.
On any non-zero exit, stop and report — do not delete anything.

## Stage 3 — Background delete

To print the plan without deleting anything (same validation, same commands):

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" clean --dry-run "$RUN_DIR"
```

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" clean "$RUN_DIR"
```

Returns immediately with a pid and a log path. Deletion runs detached, four paths at a time,
largest first. Check progress with:

```bash
tail -20 "$RUN_DIR/clean.log"; cat "$RUN_DIR/status" 2>/dev/null
```

`status` reads `pending` while running and `done` when finished. The tail of the log reports
free space before and after. The review tab shows the same run live (from `$RUN_DIR/clean.events`),
so the user can watch it there instead of waiting on the terminal.

## What the scan covers

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

- `clean` deletes a path only if it appeared in that run's `scan.tsv`. The UI cannot smuggle
  in an arbitrary path.
- Hard-blocked regardless of selection: `$HOME` itself, anything outside `$HOME` other than
  `/private/tmp` entries and the per-user `$TMPDIR` tree, and
  `Documents`, `Desktop`, `Pictures`, `Movies`, `Music`, `.ssh`, `.gnupg`, `.aws`, `.kube`,
  `.claude`, `Library/Mail`, `Library/Messages`, Keychains. Rejects land in `$RUN_DIR/rejected`.
- Only three shell commands can ever run, by fixed id: `xcrun simctl delete unavailable`,
  `docker system prune -f` (dangling only, never named volumes), `brew cleanup --prune=all -s`.
- Worktrees are never `rm -rf`'d: they are only removed with `git worktree remove`
  after a fresh re-check. A worktree that changed after the scan is kept and logged as `KEPT`.
- No `sudo`, ever. System-level caches under `/Library` and `/private/var` are out of scope.
- Deletion is permanent — items go straight out, not to the Trash.

## Re-running

Each run gets its own directory under `~/.cache/disk-clean/`. Old run directories are kept for
audit and are safe to delete. To re-open the UI for a completed scan without rescanning, pass the
run directory: `review "$RUN_DIR"` (it starts in the finished state and prints only the
`selection.json` path on approval). `scan [RUN_DIR]` still runs the scan alone, without a page.

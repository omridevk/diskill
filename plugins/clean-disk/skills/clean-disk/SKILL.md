---
name: clean-disk
description: Find reclaimable disk space on this Mac, show a browser UI listing exactly what will be deleted, and run the approved deletion in the background. Use when the user asks to clean up disk space, free space, find what is eating the disk, or invokes /clean-disk.
---

# Clean Disk

Three stages, run in order. Never skip the review stage — nothing is deleted without an explicit approval in the UI.

All three stages go through one launcher. It runs the `clean-disk` binary for this plugin version,
fetching it on first use (the published release, checksum-verified, or a `cargo build` from the
bundled source when no release exists). The first run may print a download or build line on stderr.

## Stage 1 — Scan

```bash
RUN_DIR=$(bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" scan)
echo "$RUN_DIR"
```

One to three minutes: a single parallel walk of the data volume, with the git worktree checks
running alongside it. Writes three files into `$RUN_DIR`:
`scan.tsv` (cleanable items), `map.tsv` (full home-directory size tree), `disk.tsv`
(volume totals and snapshot count).
Report the total found and move straight on to stage 2.

Tunable via environment variables: `CLEAN_DISK_MIN_BYTES` (default 10 MB floor per item),
`CLEAN_DISK_STALE_DAYS` (default 90), `CLEAN_DISK_BIGFILE_BYTES` (default 1 GB),
`CLEAN_DISK_OLD_DOWNLOAD_DAYS` (default 180), `CLEAN_DISK_MAP_DEPTH` (default 5),
`CLEAN_DISK_MAP_MIN_BYTES` (default 200 MB), `CLEAN_DISK_NM_DEPTH` (default 9),
`CLEAN_DISK_NM_MIN_BYTES` (default 5 MB), `CLEAN_DISK_SKIP_MAP=1` to skip the storage map
and walk only the home and temp folders instead of the whole volume.

## Stage 2 — Review UI

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/run.sh" "${CLAUDE_PLUGIN_DATA}" review "$RUN_DIR"
```

Opens a local page in the default browser and **blocks** until the user clicks Approve or Cancel.
Tell the user to switch to the browser tab before running it — the terminal will look idle.

The page has two tabs:

- **Cleanup** — the selectable list. Live search, sort (size, name, item count), minimum-size
  filter, **minimum-age filter**, risk chips (safe / review / report only), select-all-shown,
  deselect-all, reset-to-recommended, expand/collapse, show-only-selected, and keyboard shortcuts
  (`/` `a` `d` `r` `e` `c`). Sort by size, name, item count, or age. Any section with more than
  three items gets its own quick-select row — **all N · untouched 90+ days · untouched 1+ year ·
  none** — which is how you take all node_modules at once or just the stale ones. A banner warns
  when selected items are hidden behind a filter, and picking anything marked `review` turns
  Approve into a two-click confirm.
- **Preview commands** (footer button) — a dry run. Shows the exact shell commands Approve would run
  for the current selection (`rm -rf -- '<path>'`, `git -C <repo> worktree remove <path>`, the fixed
  commands), plus anything the safety checks reject. Nothing runs; the list is built by the same
  validation code `clean` uses, with worktrees re-checked live.
- **Storage map** — read-only, DaisyDisk-style. A three-ring **sunburst** of the home directory:
  hover to highlight a branch and inspect it, click a segment to zoom into it, click the hub or a
  breadcrumb to go back up. Segments the Cleanup tab can act on are outlined with a white dashed
  stroke. Below it, the whole disk reconciles exactly (home folder + rest of the data volume +
  macOS system volume and APFS reserve + free = total), followed by the same tree as an
  expandable list. This is where the space this skill *cannot* reclaim shows up.

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
free space before and after.

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
`CLEAN_DISK_REPO_DEPTH`) and every worktree it has registered, wherever that worktree lives
(including `/private/tmp` scratchpads). A worktree is offered for removal only when ALL of these hold:
clean `git status` including untracked files, not locked, no process has its cwd inside, no
merge/rebase/cherry-pick/revert/bisect in progress, no submodules, no worktree-only refs, on a
named branch (or a detached HEAD some ref contains), no commit in its HEAD reflog that no
branch/tag/remote/stash holds, and every git-ignored file is known build output (`node_modules`,
`dist`, `.turbo`, caches, ...). Anything else, such as `.env`, `.idea` or plan folders, keeps it. Idle for
`CLEAN_DISK_WORKTREE_IDLE_DAYS` (default 2) means preselected. Everything else is listed report-only
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

Each run gets its own directory under `~/.cache/clean-disk/`. Old run directories are kept for
audit and are safe to delete. To re-open the UI for a completed scan without rescanning, run
stage 2 again with the same `$RUN_DIR`.

# diskill

A [Claude Code](https://code.claude.com) plugin marketplace for keeping a Mac disk in check.

## Plugins

### clean-disk

Finds reclaimable disk space on macOS, opens a local review page listing exactly what would be
deleted, and deletes only what you approve.

- **Scan**: caches, logs, package-manager caches, Xcode data, every `node_modules`, stale build
  output, temp folders, Docker, app code-signing clones, and git worktrees with no leftover work.
  It also builds a storage map of the whole disk, so you can see the space it can't reclaim.
- **Review**: a browser page with search, filters, per-section quick-select and a sunburst storage
  map. Nothing is deleted until you click Approve.
- **Delete**: runs in the background and logs free space before and after.

Safety:

- Only paths from that run's scan can be deleted.
- `Documents`, `Desktop`, `.ssh`, keychains and other personal folders are hard-blocked.
- There is no `sudo`.
- Git worktrees are removed only with `git worktree remove` (never `--force`), and only after every
  check passes again right before removal:
  - a clean `git status`, including untracked files
  - no process running inside it
  - no merge or rebase in progress
  - no commits that exist only in that worktree
  - no ignored files except known build output
- The branch and all its commits always stay.

Requirements: macOS, `python3`, `git`.

## Install

In Claude Code:

```
/plugin marketplace add omridevk/diskill
/plugin install clean-disk@diskill
```

Or from a shell:

```bash
claude plugin marketplace add omridevk/diskill
claude plugin install clean-disk@diskill
```

Then ask Claude to "clean up my disk", or run `/clean-disk`.

Update with `claude plugin update clean-disk@diskill`.

## Development

```bash
claude plugin validate --strict .
claude plugin validate --strict ./plugins/clean-disk
bash plugins/clean-disk/skills/clean-disk/scripts/test_worktrees.sh
```

Bump `version` in `plugins/clean-disk/.claude-plugin/plugin.json` on every release. Installed copies
only update when that string changes.

## License

MIT

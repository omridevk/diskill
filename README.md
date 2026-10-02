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

Requirements: macOS and `git`. Rust only if building from source.

The skill runs a single `clean-disk` binary through `scripts/run.sh`. On first use it downloads
the release built for the installed plugin version from
[GitHub releases](https://github.com/omridevk/diskill/releases), checks its sha256, and caches it
in the plugin data folder. If no release exists for that version, it builds the bundled source
with `cargo build --release --locked` instead (needs [Rust](https://rustup.rs)).

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

The CLI source lives in `plugins/clean-disk/cli` (Rust 1.93, edition 2024).

```bash
cd plugins/clean-disk/cli
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
cargo run --release -- scan        # read-only; writes a run dir under ~/.cache/clean-disk
cd -
shellcheck plugins/clean-disk/skills/clean-disk/scripts/run.sh
claude plugin validate --strict .
claude plugin validate --strict ./plugins/clean-disk
```

The tests build every fixture in a temp folder. Deletion is only ever exercised there.

## Releasing

1. Bump `version` in `plugins/clean-disk/.claude-plugin/plugin.json` (and in `cli/Cargo.toml`).
   Installed copies only update when that string changes, and `run.sh` fetches the binary for it.
2. Tag with `claude plugin tag ./plugins/clean-disk` (creates `clean-disk--v<version>`) and push the tag.
3. The `release` workflow checks the tag matches `plugin.json`, builds an arm64 + x86_64 universal
   binary, and publishes `clean-disk-macos-universal.tar.gz` with its `.sha256` and a signed
   build provenance attestation. Crates are fetched through Socket Firewall Free, then built offline.

To verify a downloaded release came from this repo's workflow:

```bash
gh attestation verify clean-disk-macos-universal.tar.gz --repo omridevk/diskill
```

## License

MIT

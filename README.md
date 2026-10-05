# diskill

A [Claude Code](https://code.claude.com) plugin marketplace for keeping a Mac disk in check.

## Plugins

### disk-clean

Finds reclaimable disk space on macOS, opens a local review page listing exactly what would be
deleted, and deletes only what you approve.

- **Scan**: caches, logs, package-manager caches, Xcode data, every `node_modules`, stale build
  output, temp folders, Docker, app code-signing clones, and git worktrees with no leftover work.
  It also builds a storage map of the whole disk, so you can see the space it can't reclaim.
- **Review**: a browser page that opens as soon as the scan starts and fills in while it runs, with
  search, filters, per-section quick-select and a sunburst storage map. Nothing is deleted until
  you click Approve.
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

The skill runs a single `disk-clean` binary through `scripts/run.sh`. On first use it downloads
the release built for the installed plugin version from
[GitHub releases](https://github.com/omridevk/diskill/releases), checks its sha256, and caches it
in the plugin data folder. If no release exists for that version, it builds the bundled source
with `cargo build --release --locked` instead (needs [Rust](https://rustup.rs)).

## Install

In Claude Code:

```
/plugin marketplace add omridevk/diskill
/plugin install disk-clean@diskill
```

Or from a shell:

```bash
claude plugin marketplace add omridevk/diskill
claude plugin install disk-clean@diskill
```

Then ask Claude to "clean up my disk", or run `/disk-clean`.

Update with `claude plugin update disk-clean@diskill`.

## Development

The CLI source lives in `plugins/disk-clean/cli` (Rust 1.93, edition 2024).

```bash
cd plugins/disk-clean/cli
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
cargo run --release -- scan        # read-only; writes a run dir under ~/.cache/disk-clean
cd -
shellcheck plugins/disk-clean/skills/disk-clean/scripts/run.sh
claude plugin validate --strict .
claude plugin validate --strict ./plugins/disk-clean
```

The tests build every fixture in a temp folder. Deletion is only ever exercised there.

The review page is a React app in `plugins/disk-clean/web` (Vite, shadcn on Base UI, Tailwind,
TanStack Charts). `pnpm run build` there writes the single self-contained
`plugins/disk-clean/cli/assets/page.html` that the binary embeds; commit it with any web change
(CI fails when it is stale). Cargo builds never need Node.

```bash
pnpm install
cd plugins/disk-clean/web
pnpm test            # browser tests, headless Chromium
pnpm run build       # rebuilds cli/assets/page.html
pnpm dev             # needs dev/fixture.json: {"data": <review page data>, "token": "..."}
```

Set `DISK_CLEAN_REVIEW_URL` to a running `disk-clean review` server to proxy `/preview` and
`/decide` to it during `pnpm dev`.

## Releasing

1. Bump `version` in `plugins/disk-clean/.claude-plugin/plugin.json` (and in `cli/Cargo.toml`).
   Installed copies only update when that string changes, and `run.sh` fetches the binary for it.
2. Tag with `claude plugin tag ./plugins/disk-clean` (creates `disk-clean--v<version>`) and push the tag.
3. The `release` workflow checks the tag matches `plugin.json`, builds an arm64 + x86_64 universal
   binary, and publishes `disk-clean-macos-universal.tar.gz` with its `.sha256` and a signed
   build provenance attestation. Crates are fetched through Socket Firewall Free, then built offline.

To verify a downloaded release came from this repo's workflow:

```bash
gh attestation verify disk-clean-macos-universal.tar.gz --repo omridevk/diskill
```

## License

MIT

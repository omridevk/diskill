# disk-clean on Linux (step 2 of cross-platform.md)

Status: draft 2026-10-05. Builds on step 1 (PR #5, branch `platform-boundary`). Parent spec:
`cross-platform.md`; research with sources: `research/linux-locations.md` (agent output: a proposal,
cited below by row number, e.g. "row 2.2").

## Goal

The same binary, page and safety promises on Linux (x86_64 and arm64): scan the home folder, review in
the page, Delete moves approved items to the freedesktop.org Trash, Undo and Empty work, nothing
needs root. macOS behaviour does not change; the macOS suite stays green unedited except where a test
is split per platform (below).

## Code layout

- `src/platform/mod.rs` picks `macos` or `linux` with `#[cfg(target_os = ...)]`.
- `src/platform/unix/`: code whose body is identical on macOS and Linux moves here verbatim from
  `platform/macos/` (for example `no_follow`, `create_private_dir`, `uid`, `dev_and_ino`, `same_item`,
  `file_id`, `meta_of`, `spawn_detached`, `pass_lock`, `keep_lock_from_commands`, `wait_for_connection`,
  `local_time`, `local_midnights`, `day_label`). `macos/mod.rs` and `linux/mod.rs` re-export it. Nothing
  is written twice. A function goes to `unix/` only when its body compiles and is correct on both, unchanged.
- `src/platform/linux/` exports exactly the names `platform/macos/` exports today (the list is
  `grep -E '^pub' src/platform/macos/*.rs`), with Linux bodies. Code outside `src/platform/` does not
  change for Linux, except tests and CI.
- No new crates. `libc` covers every call below.

## Behaviour per area (Linux bodies)

| Area | Linux |
|---|---|
| Volume totals, `data_mount` | `statvfs`; the data mount is the mount holding `$HOME` |
| `user_tmp_base` | `None` (no per-user `$TMPDIR` tree) |
| Walk | `std::fs::read_dir` + `symlink_metadata` (no bulk call); allocated size from `st_blocks`; a directory is a mount point when its `st_dev` differs from its parent's; symlinks never followed |
| Scan priority | lower CPU and IO priority of the current thread (`setpriority`), no root |
| Core count | `available_parallelism` |
| Random bytes | `getrandom` |
| Open the page | `xdg-open`; a failure is not an error (the page address is still printed) |
| `process_cwds` | read `/proc/<pid>/cwd` links of processes owned by the user's uid |
| `rename_excl` | `renameat2` with `RENAME_NOREPLACE`; `EXDEV` is reported, never turned into copy+delete |
| Trash | freedesktop.org Trash spec 1.0: home trash `$XDG_DATA_HOME/Trash` (`~/.local/share/Trash`); an item on another volume goes to that volume's `$topdir/.Trash-$uid` (created 0700 if missing; `$topdir/.Trash/$uid` used when it exists and passes the spec's checks); a `.trashinfo` is written before the move (`Path` percent-encoded, `DeletionDate` local time); name collisions get a suffix; an item the Trash cannot take is kept and reported with the reason, never deleted |
| Restore (Undo) | move back without overwriting, then remove the `.trashinfo` |
| Empty | remove only items in our Trash record, with their `.trashinfo`; a read-only tree (Go module cache) gets `u+w` on its folders first |
| Sync | an item restored or emptied by a file manager is picked up like on macOS (record marked, never acted on twice) |
| Protected | `$HOME` and its ancestors; `.ssh .gnupg .aws .kube .claude` as on macOS; the XDG user dirs DESKTOP, DOCUMENTS, PICTURES, MUSIC, VIDEOS, TEMPLATES, PUBLICSHARE read from `user-dirs.dirs` plus their English defaults (row 7.2); `~/.config/gh`, `~/.config/gcloud`, keyrings, `kwalletd`, `~/.password-store`, `~/.pki`, browser profiles (`~/.config/google-chrome`, `~/.config/chromium`, `~/.mozilla`), `~/.thunderbird`, `~/.docker`, `~/.cache/disk-clean`, Hugging Face `token` files, `~/.android` (rows 7.4 to 7.15); comparison case-insensitive as on macOS (only blocks more) |
| Allowed roots | inside `$HOME`; inside `/tmp` and `/var/tmp`; the per-volume trash folders we created or recorded (for Empty) |
| `SYSTEM` backstop | `/usr /bin /sbin /lib /lib64 /etc /var /opt /boot /root /srv /snap /proc /sys /dev /run /nix`, with `/var/tmp` allowed |
| Fixed commands | `docker-prune` only, offered as on macOS (Review first, not ticked). No Homebrew, no simulators, no new commands |
| Snapshots, simulators | none: probes return 0 / false |

## Locations (the "ticked by default" list shown to the user on 2026-10-05)

Ticked by default (Safe):
- Trash: children of `~/.local/share/Trash/files` (with their `.trashinfo`)
- npm `~/.npm/_cacache`, `~/.npm/_npx`
- pnpm `~/.cache/pnpm`; yarn `~/.cache/yarn`, `~/.yarn/berry/cache`; bun `~/.bun/install/cache`
- pip `~/.cache/pip`; uv `~/.cache/uv`
- poetry `~/.cache/pypoetry/cache`, `~/.cache/pypoetry/artifacts`; `~/.cache/pre-commit`; `~/.cache/node/corepack`
- cargo `~/.cargo/registry/cache`; go `~/.cache/go-build`; `~/.cache/composer`; `~/.cache/deno`;
  `~/.cache/electron`; `~/.cache/node-gyp`; `~/.cache/Homebrew`
- `~/.cache/ms-playwright`, `~/.cache/puppeteer`
- ccache: children of `~/.cache/ccache` except `ccache.conf`; `~/.cache/huggingface/xet`
- browser disk caches `~/.cache/google-chrome`, `~/.cache/chromium`, `~/.cache/mozilla`
- `~/.cache/thumbnails`, `~/.cache/mesa_shader_cache` (and `_db` variants), `~/.cache/fontconfig`
- Flatpak `~/.var/app/*/cache`; snap `~/snap/*/*/.cache` (the exceptions below apply inside both)
- `node_modules` and stale build output: same rules as macOS

Shown, not ticked (Review first): every other child of `~/.cache`, minus the never-offered list;
the stores at macOS parity (`~/.cargo/registry/src`, `~/go/pkg/mod`, `~/.m2/repository`,
`~/.gradle/caches`, `~/.gem`, `~/.local/share/pnpm/store`); the user's own entries of `/tmp` and
`/var/tmp` (on tmpfs a trashed `/tmp` item keeps its RAM until Empty and is gone at reboot; the row's
note says so); Docker prune.

Never offered inside `~/.cache`: `disk-clean`, `huggingface` (only `xet` is offered), `pypoetry/virtualenvs`,
`JetBrains`, `bazel`, `torch` (rows 2.1 to 2.10).

Report only: big files and old Downloads (Downloads resolved through `user-dirs.dirs`), as on macOS.

Anything else from the research (Electron caches under `~/.config`, Android, snap revisions, Flatpak
leftovers, Steam, core files, new commands) is not in this step.

## Tests

- The throwaway volume on Linux is a `tmpfs` mounted by the test harness (`mount -t tmpfs`, as root or
  through `sudo -n`); a second one for the other-volume trash cases. The guard that fails any test
  touching a path outside the volume applies unchanged.
- Existing tests that assert macOS facts (`~/.Trash`, `Library/...`, Finder) are split with
  `#[cfg(target_os = "macos")]` and get a Linux twin asserting the freedesktop result. A macOS test's
  body is not otherwise edited.
- New Linux cases: trash on the home volume and on the second volume; `.trashinfo` written and
  honoured; restore refusing to overwrite; an item restored or emptied by hand (the file manager's way)
  picked up by sync; a protected localized user dir (`user-dirs.dirs` naming `Bilder`) rejected.
- Local run on a Mac: the suite in a privileged `rust:1.93` Linux container (both arm64 and, through
  emulation, x86_64 when practical). CI: a `ubuntu-latest` job running fmt, clippy and the full suite,
  beside the macOS job.

## Settled during integration (2026-10-05)

- **Items already in a Trash** that a cleanup removes for good take their `.trashinfo` with them, and a
  read-only tree is made writable first, the same steps Empty takes.
- **The home Trash is resolved once.** The scan's Trash row and the Trash itself use the same
  `$XDG_DATA_HOME/Trash` resolution; no second spelling of the path.
- **Downloads** for the old-downloads report is the XDG DOWNLOAD dir from `user-dirs.dirs`, else
  `~/Downloads`; on macOS it stays `~/Downloads`. The `user-dirs.dirs` reader is shared with the
  protected list, not written twice.
- **Home under a system folder** (Fedora Silverblue and Kinoite put it at `/var/home/<user>`): a
  `SYSTEM` entry that is an ancestor of `$HOME` does not block paths inside `$HOME`. Paths outside
  `$HOME` stay blocked as before.
- **User-facing texts in neutral code that name macOS** become per-platform constants; the macOS
  strings stay byte-identical. Linux wording: "Finder's Put Back" becomes "your file manager's
  Restore"; "on this Mac" becomes "on this computer"; the Docker note says that with Docker Desktop
  the space stays inside its VM disk until that disk is reset, and that named volumes are never
  touched.
- **Opening the page on Linux** does not wait for `xdg-open` to exit.
- **Test fixtures that depend on a platform limit** (path length for "nested too deep") take the
  limit from a per-platform helper in `tests/common`, not a second copy of the test.

## Release assets and launcher (draft 2026-10-05, after PRs #5, #6, #8)

User stories 27, 28 and 35 of `cross-platform.md` for Linux. Today `release.yml` publishes only
`disk-clean-macos-universal.tar.gz`, and `run.sh` `download()` returns early on anything but Darwin,
so every Linux user builds from source.

### Assets

| Asset | Rust target | Built on |
|---|---|---|
| `disk-clean-macos-universal.tar.gz` | unchanged | unchanged |
| `disk-clean-linux-x86_64.tar.gz` | `x86_64-unknown-linux-musl` | `ubuntu-24.04` |
| `disk-clean-linux-arm64.tar.gz` | `aarch64-unknown-linux-musl` | `ubuntu-24.04-arm` |

- Each tarball holds one file, `disk-clean` (mode 755), as the macOS one does. Each has a
  `<asset>.sha256` in the `sha256sum` format (`<hash>  <asset>`), which `shasum -a 256 -c` also reads.
- **Static musl, not glibc** (proposed, the user's to confirm). A glibc binary built on Ubuntu 24.04
  needs glibc 2.39 and does not start on Debian 12, RHEL 9 or Alpine; a static musl binary runs on any
  Linux kernel the code supports. Every `libc` call the Linux code makes exists for musl in `libc`
  0.2.189 (`getrandom`, `setpriority`, `statvfs`, `SYS_renameat2`, `RENAME_NOREPLACE` checked). No C
  dependency, no new crate, no cross toolchain: each architecture builds natively on its own runner
  with Rust's bundled musl.
- The source build (launcher fallback, `cargo run`) keeps using the host's default target.

### release.yml

- The macOS job is unchanged except for the name of its uploaded artifact. The tag check (tag matches
  `plugin.json`) stays in exactly one job.
- One new job, a two-entry matrix (the table above), each entry: checkout, toolchain 1.93 with the
  musl target, Socket Firewall fetch and report exactly as the macOS job does them, `cargo build
  --release --frozen --target <target>`, a step that fails unless the binary is statically linked,
  tar, sha256, upload as its own artifact. Same pinned action SHAs, `permissions: contents: read`.
- `publish` needs every build job, downloads all artifacts, checks every `.sha256`, attests all three
  tarballs in one `attest-build-provenance` call (`subject-path` lists them), and attaches all six
  files to the one release.
- zizmor stays clean.

### CI

- The Linux job becomes a matrix over `ubuntu-latest` and `ubuntu-24.04-arm` and runs fmt, clippy and
  the full suite for the musl target, so the shipped target is what the suite exercises on both
  architectures ("a platform is not released until its runner is green"). The host-target build
  stays covered by clippy on the host target.

### run.sh

- The asset comes from `uname -s` and `uname -m`: `Darwin` any arch to the macOS universal asset;
  `Linux` with `x86_64` to `linux-x86_64`; `Linux` with `aarch64` or `arm64` to `linux-arm64`; anything
  else skips the download and goes to the source build, as Linux does today.
- Checksum tool: `sha256sum -c` when present, else `shasum -a 256 -c`; with neither, no download (the
  source build runs). The existing rules hold: the `.sha256` must name the expected asset, a mismatch
  exits 1 with the existing message and never runs or builds, a failed download falls back to the
  source build.
- Messages stay byte-identical on macOS. `shellcheck` stays clean.

### Docs

- README: requirements say macOS or Linux; the release section lists the three assets and the
  `gh attestation verify` line for each. SKILL.md drops "On Linux it is built from source with cargo
  for now."

### Checks

- Local, on the branch: build both musl targets in `rust:1.93` containers (arm64 native, x86_64
  under `--platform linux/amd64`); `file` reports static; each binary runs a scan in a sandboxed home
  on `debian:12`, `ubuntu:20.04` and `alpine` (glibc-independence).
- `run.sh` on Linux in a container for each arch, with `curl` on `PATH` replaced by a stub serving the
  locally built tarball and its `.sha256`: picks the right asset, installs, runs; a tampered `.sha256`
  exits 1 with the mismatch message; no `sha256sum`/`shasum` falls to the source build. Same on macOS
  for the universal asset (unchanged behaviour).
- `actionlint`/zizmor clean on both workflows. The release workflow itself is first exercised by the
  next tag; it is not run before that.

## Not in this step

Windows, the page, SKILL.md text beyond naming the Linux Trash and the launcher line above.

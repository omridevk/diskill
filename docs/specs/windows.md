# disk-clean on native Windows (step 3 of cross-platform.md)

Status: approved 2026-10-05, building. Builds on step 2 (`linux.md`, PRs #5, #6, #8) and the Linux release assets
(branch `linux-release`). Parent spec: `cross-platform.md`; research with sources:
`research/windows-locations.md` (cited by row id, e.g. "W2", "P10"). The "ticked by default" list and
the six owner questions were answered in conversation on 2026-10-05 ("what you think is right, but best
experience", then "go"); the answers are recorded under Locations.

## Goal

The same binary, page and safety promises on Windows 10 and 11 (x86_64 and arm64), native, not WSL:
scan the user's profile, review in the page, Delete moves approved items to the Recycle Bin, Undo and
Empty work, nothing needs administrator rights. macOS and Linux behaviour does not change; their suites
stay green unedited except where a test is split per platform.

## Decisions (settled 2026-10-05: the proposals below were accepted, "stop waiting for me, start building")

1. **Path form inside disk-clean.** Neutral code (`review.rs`, `clean.rs`, `util.rs`, `worktrees.rs`) and
   the page build trees and check canonical form by splitting on `/`. Proposed: on Windows the scan
   record, run directory and page carry paths with forward slashes and an upper-case drive letter
   (`C:/Users/you/AppData/Local/npm-cache`); the Windows platform module converts to `\\?\C:\...` for
   every file call; the page shows and copies paths in Windows form (`C:\Users\you\...`) through one
   function in `web/src/lib/platform.ts`. Neutral Rust changes only where it assumes `/` is the one
   root (the root becomes the drive, `C:/`). The alternative, native backslash paths everywhere, means
   rewriting every `/` split in neutral Rust and the page.
2. **File identity on ReFS (Dev Drive).** The Trash record keeps `dev: u64, ino: u64`. On NTFS the
   identity is the volume serial plus the 64-bit file index, which fits exactly. ReFS, which Windows
   11 uses for Dev Drives (where `node_modules` and caches often live), has 128-bit file IDs.
   Proposed: the record gains one optional field, `ino_hi` (the high 64 bits of `FILE_ID_INFO`);
   `dev` is the volume serial and `ino` the low 64 bits. It is absent on macOS, Linux and NTFS, and a
   record without it reads as `ino_hi = 0`, so existing records stay valid. The alternative is to keep
   the format and refuse Undo for items on ReFS.
3. **Running the Windows suite.** There is no Windows machine here; the suite can only run on a
   GitHub Windows runner, which means pushing the `windows` branch so CI runs on it. Proposed: push
   the branch (no PR) whenever a Windows task is ready for review, with your OK each time or once for
   this step.
4. **Processes working inside a worktree.** macOS and Linux read each process's current directory;
   Windows has no documented call for another process's current directory (only reading its memory
   at undocumented offsets). Proposed: `process_cwds` returns an empty list on Windows, and the
   worktree row's note says "close terminals and editors open in it first". The backstop is the OS: a
   process whose current directory is inside the folder holds it open, so the Recycle Bin move fails
   and the item is kept and reported "in use".

## Code layout

- `src/platform/mod.rs` picks `macos`, `linux` or `windows` with `#[cfg(target_os = ...)]`.
- `src/platform/windows/` exports exactly the names `platform/linux/` exports (the list is
  `grep -E '^pub' src/platform/{linux,unix}/*.rs`), with Windows bodies. Where a name's type is
  Unix-shaped (`uid() -> u32`), the Windows body keeps the signature and the meaning stated below; a
  neutral caller changes only if decision 1 or 2 requires it, and each such change is listed in the
  task's report.
- New crate, Windows only: Microsoft's `windows` crate (windows-rs), under
  `[target.'cfg(windows)'.dependencies]`, with only the features the module calls (Shell, COM,
  file system, security, threading, known folders). It is needed because the Recycle Bin is reached
  through `IFileOperation`, a COM interface; `windows-sys` has no COM ("It lacks support for COM and
  WinRT APIs", Kenny Kerr, windows-rs author, kennykerr.ca/rust-getting-started/windows-or-windows-sys,
  read 2026-10-05). macOS and Linux builds pull no new crate.
- Every `unsafe` block gets a `// SAFETY:` comment like the existing ones.

## Behaviour per area (Windows bodies)

| Area | Windows |
|---|---|
| Home and per-user folders | `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `TEMP`/`TMP` from the environment when set (Windows sets them for every process; the tests point them at the sandbox, the same seam as `HOME` on macOS and Linux); else the Known Folder (`FOLDERID_Profile`, `_LocalAppData`, `_RoamingAppData`) and `GetTempPath2W`. Protected Known Folders (Documents, Desktop, ...) are always resolved with `SHGetKnownFolderPath` as well, so a redirected folder is blocked whatever the environment says. Paths the binary prints and writes use the decision 1 form |
| Volume totals, `data_mount` | `GetDiskFreeSpaceExW`; the data mount is the volume holding the profile |
| `user_tmp_base` | `GetTempPath2W` result when it is inside the profile, or on a fixed local drive and not the Windows folder or a drive root (W2 rule, owner answer 6); else `None` |
| Walk | one directory handle per folder, read in bulk with `GetFileInformationByHandleEx(FileIdExtdDirectoryInfo)` (128-bit file id, attributes, reparse tag, sizes, allocation size, last write time per entry; amended 2026-10-05 at review: no per-file open, no per-file `GetCompressedFileSizeW`); allocated size is the entry's `AllocationSize`; hard links are counted once by (volume serial, file id) for every file, since the bulk read carries no link count; never opens a file carrying `RECALL_ON_OPEN` or `RECALL_ON_DATA_ACCESS` (online-only placeholders report no allocation, so they size 0); every reparse point whose tag is a name surrogate (junction, symlink, mount point) is a link, listed as itself and never entered; cloud-tagged entries are never offered |
| Hard links | counted once per (volume serial, file id); `nlink` from `FILE_STANDARD_INFO` |
| File identity everywhere | one function reads `FILE_ID_INFO` (volume serial, 128-bit id) for the walk, the Trash record and the log-rotation check in `watch.rs`; no identity from creation times |
| Mount points | a folder is a mount point when it is a mount-point reparse point or its volume serial differs from its parent's |
| Paths | `\\?\` for every file call; comparison case-insensitive with `CompareStringOrdinal(..., TRUE)`; a component with `~` whose long form differs is rejected (8.3 names) |
| Scan priority | `THREAD_MODE_BACKGROUND_BEGIN` on scan threads, no admin |
| Core count | `available_parallelism` |
| Random bytes | `ProcessPrng` (bcryptprimitives) or `BCryptGenRandom` |
| Open the page | `ShellExecuteW` "open"; a failure is not an error (the address is still printed) |
| Detached worker, run lock | `CreateProcessW` with `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`; the lock is `LockFileEx` on the same lock file; the lock handle is passed only to the worker, never to fixed commands |
| `process_cwds` | empty (decision 4) |
| `rename_excl` | `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` and without `MOVEFILE_COPY_ALLOWED` (same volume only; a cross-volume move is reported, never copied) |
| Trash | `IFileOperation` with `FOFX_RECYCLEONDELETE | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING`, not `FOFX_EARLYFAILURE`; the landed `$R…` path from `PostDeleteItem`'s `psiNewlyCreated`; `psiNewlyCreated == NULL` is treated as "deleted for good" and must never happen: before the move the item's volume must be a fixed local NTFS/ReFS volume with a Recycle Bin and the item no larger than that drive's Recycle Bin capacity, else it is kept and reported ("NOT TRASHED: larger than the Recycle Bin on this drive", "NOT TRASHED: this drive has no Recycle Bin", "NOT TRASHED: the Recycle Bin is turned off on this drive"). Corrected 2026-10-05: `SHQueryRecycleBinW` gives only the bin's current size, not its capacity (learn.microsoft.com shellapi `SHQUERYRBINFO`). The capacity and the "don't move files to the Recycle Bin" switch exist only as the per-volume registry values `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\{GUID}\MaxCapacity` (MB) and `NukeOnDelete`, which Microsoft does not document; disk-clean reads them read-only (volume GUID from `GetVolumeNameForVolumeMountPointW`); when `MaxCapacity` is absent it uses Windows' default (research section 9, Raymond Chen); `NukeOnDelete = 1` keeps every item on that drive. One `IFileOperation` per item, so the sink's callbacks belong to that item without matching paths. When the reported `$R…` path is not inside the user's own `<drive>/$Recycle.Bin/<SID>` (seen on Windows arm64: `Z:/$RECYCLE.BIN/$R…` with no SID folder), disk-clean looks in that folder for the `$R…` entry whose (volume serial, file id) equals the identity read before the move and records that path; if none matches, the record stays failed and its reason says whether the reported path holds the item and whether a matching `$R…` sits in the SID folder or directly under `<drive>/$Recycle.Bin`. |
| In use | `ERROR_SHARING_VIOLATION` and friends from the per-item HRESULT: kept and reported "in use: close <the program> and retry" when the holder is known (Restart Manager `RmGetList`), else "in use by another program" |
| Restore (Undo) | `MoveFileExW` of the recorded `$R…` back to the original, no overwrite, then delete the matching `$I…` |
| Empty | delete only recorded `$R…` items whose identity still matches, with their `$I…`; read-only attributes cleared first; never `SHEmptyRecycleBin` |
| Sync | same rules as macOS: at the `$R…` path with the same identity is "in the Recycle Bin"; at the original with the same identity is "put back"; neither is "emptied"; anything else is failed |
| Protected | section 7 Never list of the research, case-insensitive: profile root and ancestors; Known Folders Documents, Desktop, Pictures, Music, Videos at their resolved target and their default path; OneDrive and every registered cloud sync root; `.ssh .gnupg .aws .kube .azure .claude .docker`; `%APPDATA%\gnupg`; DPAPI, Credentials, Vault, Crypto, SystemCertificates; browser profiles minus their named caches; Outlook and `*.pst`; Thunderbird; password managers and `*.kdbx`; packaged-app state (W11); WSL and Docker disks; toolchain roots X1 to X8; `~/.cache/disk-clean`'s Windows twin (the plugin data folder); `%LOCALAPPDATA%\Programs` (per-user installed apps; added at integration) |
| Allowed roots | inside the profile; the per-user temp base from above; the user's own `$Recycle.Bin\<SID>` folders on fixed drives (for Empty); outside the profile, the rule in "All fixed drives" |
| `SYSTEM` backstop | `FOLDERID_Windows`, `ProgramFiles`, `ProgramFilesX86`, `ProgramData`, other users' profiles, `System Volume Information`, other SIDs' Recycle Bin folders |
| `uid` | unused for ownership on Windows; owner checks compare the entry's owner SID with the token user's SID |
| Fixed commands | `docker-prune` only, Review first, with the Windows note (owner answer 5). No Homebrew, no simulators, no Scoop commands |
| Snapshots, simulators | none: probes return 0 / false |
| Page platform | `PAGE_PLATFORM = "windows"` |

## Locations (ticked list shown 2026-10-05, owner answers recorded)

Ticked by default (Safe): W1 own Recycle Bin items; W3 `INetCache`; W4 `thumbcache_*.db`,
`iconcache_*.db`; W5 `CrashDumps`; W6 WER `ReportArchive`, `ReportQueue`; W7 `D3DSCache`; W8 NVIDIA
`DXCache`, `GLCache`, AMD `DxCache`; W9 `Packages\<app>\TempState`; B1 B2 Chrome and Edge `Cache`,
`Code Cache`, `GPUCache`, `ShaderCache`, `GrShaderCache`; B3 VS Code `Cache`, `CachedData`, `Code
Cache`, `GPUCache`, `logs`; B4 Slack caches; B5 Discord caches; B7 Firefox `cache2`; P1 P2 npm
`_cacache`, `_npx`; P3 pnpm-cache; P4 Yarn classic; P7 Yarn Berry global cache; P8 bun cache (size
labelled estimate); P9 pip; P10 uv (ticked, size labelled estimate: uv hard-links into venvs on Windows;
owner answer 2); P11 cargo `registry\cache`; P12 go-build; P13 electron; P14 node-gyp; P15 ms-playwright;
P16 puppeteer; P17 deno; P18 Composer; P19 NuGet `v3-cache`, `plugins-cache`; P20 scoop cache; D1 Visual
Studio `ComponentModelCache`; D6 JetBrains `log`; `node_modules` and stale build output as on macOS,
plus `bin` and `obj` only beside a `.csproj`/`.fsproj`/`.vbproj` and untouched 90+ days.

Every path honours the tool's own relocation variable (`npm_config_cache`, `PNPM_HOME`, `GOCACHE`, `UV_CACHE_DIR`, ...) when it points inside the profile, else the tool's documented default; the scan does not run the tools (`npm config get` and friends), as on macOS and Linux. (Amended 2026-10-05 at integration.)

Owner answers (2026-10-05):
1. Unknown folders under `%LOCALAPPDATA%` and `%APPDATA%` are shown with their size, deletable, not
   ticked (Review first), with the note "app data, not a cache: may hold settings or sign-in". The
   Never list still blocks real data.
2. uv is ticked (above).
3. `%TEMP%`: the user's own entries untouched 7+ days are ticked; newer ones are shown, not ticked.
4. JetBrains and Android Studio system folders (D4, D7) of a version older than an installed one of
   the same product and untouched 180+ days are ticked; other version folders are Review first.
5. Docker prune is kept, Review first, with a note that the space stays inside Docker Desktop's disk
   until Docker Desktop's purge or a sparse disk gives it back.
6. A `TMP` outside the profile is scanned when it is on a fixed local drive and is not the Windows
   folder or a drive root.

Review first (shown, not ticked): W2 newer temp entries, W10 `LocalCache` per app (app name shown), B6
Teams, P5 pnpm store, P21 to P29, D3 `.vs` beside a solution, D4 D7 other version folders, D8 AVDs, D9
Unity cache, D10 Unity `Library` (both siblings present), D11 Unreal DDC, `packages` beside
`packages.config`, `TestResults` beside a test project, Docker prune.

Report only: R1 big files, R2 old Downloads (`FOLDERID_Downloads`), D12, D13 WSL disks and D14 Docker
disk (with how to compact), P6 per-drive pnpm stores.

## All fixed drives (added 2026-10-05: the user, "I want to scan all drives")

Developers on Windows keep code on `D:`, a Dev Drive (ReFS) or `C:\code`, outside the profile. The scan covers
every fixed local drive, not only the profile.

- **Which drives:** every drive `GetDriveTypeW` reports as fixed with an NTFS or ReFS file system (Dev Drives
  included). Never removable, network, optical or RAM drives, and never a `subst` letter (its `QueryDosDeviceW`
  target starts with `\??\`), which reports as fixed but is a folder of another drive under a second name. The profile's drive is walked as today; the rest of
  every fixed drive (the rest of `C:` included) is walked from its root.
- **Never walked:** the Windows folder, `Program Files`, `Program Files (x86)`, `ProgramData`, other users'
  profiles, `System Volume Information`, `$Recycle.Bin` (the user's own bin is read for the Trash row as today),
  `$WinREAgent`, `Recovery`, `PerfLogs`, the page file, hibernation and swap files, and every toolchain root and
  reparse point, as in the profile.
- **What is offered outside the profile:** only what the scan already finds by rule: `node_modules`, stale build
  output (the `DEV_NAMES` rules, the .NET `bin`/`obj` rule and the project-folder rows), git worktrees with no
  leftover work, and the per-drive pnpm stores (`<drive>:\.pnpm-store`, now Review first instead of Report only).
  No cache, temp or app-data row comes from outside the profile. Big files there are Report only, as in the
  profile.
- **Ownership:** outside the profile an item is offered only when its owner SID is the user's (the same check temp
  entries use), so another account's projects on a shared drive are never offered.
- **Allowed roots** (validation, right before the move) widen to match: an item outside the profile is allowed when
  it is on a fixed local NTFS/ReFS drive, is not a drive root, is not inside any never-walked folder above, is not
  protected, and is owned by the user. "Only paths the scan showed" still applies, so nothing beyond those rows can
  be deleted.
- **Trash:** each drive's own Recycle Bin, with the existing checks (bin present and on, item not larger than it).
- **Totals and Storage:** the "free space" header and the Storage map stay on the profile's drive in this step;
  rows from other drives show their full path (`D:\...`) and count toward "Selected to free". A per-drive Storage
  map is a later step.
- **Choosing drives** (added 2026-10-05; the user: "/disk-clean regex | 'all' maybe?"): `/disk-clean` scans
  every fixed drive. `/disk-clean C D` (drive letters, any case, separated by spaces or commas) scans the profile
  plus only those drives; `/disk-clean all` is the same as no argument. SKILL.md passes the argument to the binary as
  `--drives <letters|all>` on `scan` and `review`; an unknown or non-fixed letter is an error naming it, never
  silently skipped. The profile is always scanned. The `DISK_CLEAN_DRIVES` environment variable added during the
  build is replaced by this flag (tests pass `--drives` instead). A regex was considered and not used: drive letters
  are a closed set of 26, and a letter list is easier to type and to read back. macOS and Linux reject `--drives`
  other than `all` with a message saying it is Windows-only.
- **macOS and Linux** are unchanged in this step.

## Launcher

- `scripts/run.ps1` beside `run.sh`, same arguments, same data folder rule, same version read from
  `plugin.json`, same messages. Downloads `disk-clean-windows-x86_64.zip` or
  `disk-clean-windows-arm64.zip` (from `[RuntimeInformation]::OSArchitecture`), verifies with
  `Get-FileHash -Algorithm SHA256` against the `.sha256` (which must name the asset), extracts
  `disk-clean.exe`, falls back to `cargo build` when no release exists. Works on Windows PowerShell
  5.1 and PowerShell 7.
- `run.sh` under Git Bash on Windows (`uname -s` = `MINGW*`/`MSYS*`) hands off to `run.ps1` with the
  same arguments, so either shell works.
- SKILL.md gives both commands: the bash one as today, and
  `powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/scripts/run.ps1" ...` for
  Claude Code's PowerShell tool.

## Release and CI

- Release assets: `disk-clean-windows-x86_64.zip` (`x86_64-pc-windows-msvc`, `windows-latest`) and
  `disk-clean-windows-arm64.zip` (`aarch64-pc-windows-msvc`, `windows-11-arm`), each with a `.sha256` in
  `sha256sum` format, built and attested in the same jobs pattern as Linux; static CRT
  (`-C target-feature=+crt-static`) so no Visual C++ runtime install is needed.
- CI: a Windows job matrix over `windows-latest` and `windows-11-arm` running fmt, clippy and the full
  suite. `PSScriptAnalyzer` on `run.ps1` is a local check before any change to it (not in CI: installing it
  there is an unpinned download).
- Socket Firewall on Windows (changed 2026-10-05, `docs/specs/ci-hardening.md` section 1): every Windows
  job, x86_64 and arm64, release and CI, installs sfw-free v1.15.4 itself by digest
  (`sfw-free-windows-x86_64.exe`, `sfw-free-windows-arm64.exe`, saved as `sfw.exe`) and fetches through
  `sfw cargo fetch --locked`. The `windows-11-arm` jobs use the pinned sfw-free Windows arm64 build, so
  they no longer wait on the x86_64 job or fetch without the firewall (the earlier exception existed
  only because `SocketDev/action` v1.3.2 has no `win32-arm64` build).

## Page

- `Platform` gains `windows`; `platform.ts` gets the Windows row: trash "the Recycle Bin";
  restore-by-hand "Restore in the Recycle Bin"; put-back "Restored from the Recycle Bin";
  delete-now keys `Shift+Delete`, `Shift+Backspace` (Explorer's permanent-delete key); Storage other
  hint "Program Files, Windows, other users, system-wide caches"; reserved "Windows and reserved
  space" / "system files, page file, hibernation file and restore points; need administrator";
  shared-blocks "hard links share blocks."; key labels from `formatForDisplay` with platform
  `windows` (`Ctrl+K`).
- Path display and copy in Windows form (decision 1).
- Every user-facing "Trash" on the page reads "Recycle Bin" on Windows (tab name, dialog titles and
  notes, progress verbs, "Move to the Trash", "Empty these from the Trash?", "space comes back when the
  Trash is emptied", palette action names); route paths and ids stay `trash`. macOS and Linux text
  unchanged. (Added 2026-10-05 after the page task found wording outside the first table.)
- A drive root (`C:/`) is the "Whole disk" root like `/`; the Storage breadcrumb separator is `\` on
  Windows; the path filter accepts `\` (typed `AppData\Local` matches `AppData/Local`).
- The confirm dialog's delete-for-good lines read `Remove-Item -LiteralPath '<path>' -Recurse -Force`
  on Windows in place of `rm -rf -- <path>`.
- `cli/assets/page.html` rebuilt and committed.

## Tests

- The throwaway volume on Windows is a VHDX created, formatted NTFS and mounted by the test harness
  with `diskpart` (the runner's account is an administrator); a second one for the other-drive cases.
  The guard that fails any test touching a path outside the volume applies unchanged.
- Existing tests asserting macOS or Linux facts get a Windows twin asserting the Recycle Bin result;
  a test's body is not otherwise edited. `sh(cwd, script)` fixtures run through Git Bash, present on
  GitHub Windows runners.
- New Windows cases (from `cross-platform.md`): Recycle Bin round trip; an item held open by another
  process kept and reported in use; a junction moved itself and its target untouched; case-different
  and 8.3 spellings of a protected path rejected; a path longer than 260 characters cleaned and
  restored; an online-only placeholder sized 0 without hydration is a manual check on a machine with
  OneDrive (`RECALL_ON_DATA_ACCESS` cannot be set with `SetFileAttributesW`; a real placeholder needs a
  registered sync root); an item
  larger than the bin's room kept; Explorer-style restore and empty picked up by sync.

## Tasks (parallel, disjoint files, each in its own worktree)

1. Core: `platform/windows/` disk, walk, process, time, protected, locations; `platform/mod.rs`.
2. Trash: `platform/windows/trash.rs` (Recycle Bin, Undo, Empty, sync, in-use, size and volume checks).
3. Tests and CI: `tests/common` VHDX volume, Windows twins and new cases, CI job.
4. Launcher, release, SKILL.md, README: `run.ps1`, `run.sh` hand-off, `release.yml`.
5. Page: `platform.ts` Windows row, path display, `page.html`.

Tasks 1 and 2 must merge before task 3's suite can go green; the contract is the export list above.

## Not in this step

Administrator-only locations (section 11 of the research), Scoop commands, WSL as a target, a native
installer.

# disk-clean on native Windows: locations, groups, and safety facts

This is a proposal for the owner to review. It answers open question 1 of
`docs/specs/cross-platform.md` for Windows. Nothing here is decided.

Read against `ui-v2` sources on 2026-10-05: `scan.rs` (the `PKG_CACHE`, `PKG_CACHE_TAIL`, `PKG_STORE`,
`PNPM_STORE`, `XCODE` tables and the `scan_*` functions), `walk.rs` (`NM_TOP`, `DEV_TOP`, `DEV_NAMES`,
`REPO_SKIP`), `clean.rs` (`PERSONAL`, `SYSTEM`, `COMMANDS`, `is_allowed`), and SKILL.md ("What the scan
covers", "Safety rules"). All web sources were fetched on 2026-10-05. A cell that says "no primary source
found" means just that: the claim beside it is the author's belief and still needs checking.

Groups use the macOS meanings:

- **Safe**: listed and preselected (macOS `risk=safe, pre=1`).
- **Review first**: listed, not preselected (`risk=review, pre=0`).
- **Report only**: shown with a disabled checkbox, never deletable (`risk=report`).
- **Never**: protected. Rejected by `is_allowed` whatever the selection says (Windows counterpart of
  `PERSONAL` / `SYSTEM`). Toolchain roots that the walk must skip are marked **Never (skip)**: they are
  not on the block list on macOS either, but no scan rule may offer anything inside them.

How the macOS rows map across:

| macOS row | Windows counterpart |
|---|---|
| `~/.Trash` children (Safe) | Recycle Bin items of the user's SID on each fixed drive (W1) |
| `~/Library/Caches` children (Safe) | No single folder exists (section 1). Per-tool rows W3 to W10, B1 to B7, P1 to P20 |
| `~/Library/Logs`, CrashReporter, DiagnosticReports (Safe) | `%LOCALAPPDATA%\CrashDumps`, WER report folders, JetBrains logs (W5, W6, D6) |
| `PKG_CACHE`, `PKG_CACHE_TAIL` (Safe) | P1 to P20 (Homebrew and CocoaPods have no Windows counterpart) |
| `PKG_STORE` (Review) | P21 to P29 |
| `PNPM_STORE` (Review) | P5, P6 |
| Xcode rows, simulators, iOS backups | No counterpart. Visual Studio, Android, Unity, Unreal rows D1 to D12 |
| `/private/tmp` own entries, `$TMPDIR` T and C (Review) | `%TEMP%` own entries (W2) |
| code-sign clones (Review) | No counterpart |
| Docker prune (Review, command) | Same command, plus the VHDX notes (D13, D14, section 10) |
| Large files, old Downloads (Report only) | R1, R2 |
| `node_modules`, stale build artifacts | Section 6, unchanged rules plus Windows names |

---

## 1. `%LOCALAPPDATA%`, `%APPDATA%`, `LocalLow`: none of them is a cache folder

| Known Folder | Default path | What Microsoft says it is for |
|---|---|---|
| `FOLDERID_LocalAppData` | `%LOCALAPPDATA%` = `%USERPROFILE%\AppData\Local` | Per-user, machine-local app data |
| `FOLDERID_RoamingAppData` | `%APPDATA%` = `%USERPROFILE%\AppData\Roaming` | Per-user app data meant to follow the user (roaming profiles) |
| `FOLDERID_LocalAppDataLow` | `%USERPROFILE%\AppData\LocalLow` | Low-integrity (sandboxed) processes' local data |
| `FOLDERID_InternetCache` | `%LOCALAPPDATA%\Microsoft\Windows\Temporary Internet Files` (modern Windows resolves it to `INetCache`) | Internet cache |

Source for the paths: [KNOWNFOLDERID](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid).

**There is no Windows folder equivalent to `~/Library/Caches`.**

- Microsoft's app-data guidance defines a cache-like store only for **packaged** apps. The temporary
  store "works like a cache. Its files do not roam and could be removed at any time. The System
  Maintenance task can automatically delete data stored at this location at any time." That is
  `%LOCALAPPDATA%\Packages\<PFN>\TempState`. The same page says unpackaged apps "do not have access to the
  system-managed app data stores" and must choose their own storage
  ([Store and retrieve settings and other app data](https://learn.microsoft.com/en-us/windows/apps/design/app-settings/store-and-retrieve-app-data)).
- `LocalCacheFolder` is not a cache in that sense. The same page describes it only as the folder "where
  you can save files that are not included in backup and restore". Apps keep real state there.
  Microsoft's own Teams keeps its whole client state in it (see B6).
- Local app data "should be used for any information that needs to be preserved between app sessions"
  (same page). Go's `os.UserCacheDir` returns `%LocalAppData%` on Windows and `os.UserConfigDir` returns
  `%AppData%` ([pkg.go.dev/os](https://pkg.go.dev/os#UserCacheDir)). Tools therefore put caches *and*
  settings side by side in `%LOCALAPPDATA%`: Chrome profiles, Outlook `.ost` files, JetBrains local
  history and WSL disks all live there.
- `%APPDATA%` (Roaming) holds settings by design. Electron apps (VS Code, Slack, Discord) still put their
  Chromium caches there (B3 to B5).
- `LocalLow` is a low-integrity sandbox location. Its content is per-app (for example Unity games' saves
  and player logs). **No primary source found** for any generic cache claim, so nothing under it is
  listed.

**Consequence for the scan:** the macOS rule "every child of `~/Library/Caches`" has no Windows form.
Listing every child of `%LOCALAPPDATA%` would offer browser profiles, mail stores and WSL disks. Windows
gets an explicit list of cache subfolders instead (the tables below). Nothing is offered just because it
sits in `%LOCALAPPDATA%`.

---

## 2. Windows-owned per-user caches, temp and the Recycle Bin

| # | Path | Written by | What removing it costs | Group | Source |
|---|---|---|---|---|---|
| W1 | `<drive>:\$Recycle.Bin\<user SID>\` (`$R…`/`$I…` pairs), on every fixed NTFS drive | Explorer / `IFileOperation` deletes | The items are gone for good. Nothing breaks. Not locked. | **Safe** (macOS Trash parity: "Permanently removed.") | Path layout: [libyal Recycle.Bin format](https://raw.githubusercontent.com/libyal/dtformats/main/documentation/Windows%20Recycle.Bin%20file%20formats.asciidoc) (secondary, not Microsoft). That a Recycle Bin can exist on more than one drive: [cleanmgr](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cleanmgr) |
| W2 | Entries of `%TEMP%` (resolved with `GetTempPath2`: `TMP`, then `TEMP`, then `USERPROFILE`, then the Windows directory), only when the entry's owner SID is the user's | Every program; installers; NuGet (`NuGetScratch`); winget downloads | Programs recreate what they need. A running program may hold an entry open, in which case the move fails and is reported as in use. A half-finished installer may lose its unpacked payload. | **Review first** (macOS parity). Owner decision: preselect only entries untouched for 7+ days, per Microsoft's Disk Cleanup text | [GetTempPath2W](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-gettemppath2w); "You can safely delete temporary files that haven't been modified within the last week": [cleanmgr](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cleanmgr) |
| W3 | `FOLDERID_InternetCache` (`%LOCALAPPDATA%\Microsoft\Windows\INetCache`) | WinINet: IE mode in Edge, Office, apps that use WinINet | Pages and resources are fetched again. "Disk Cleanup removes these pages but leaves your personalized settings for Web pages intact." Some files may be locked. | **Safe** | [KNOWNFOLDERID](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid); [cleanmgr](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cleanmgr); Disk Cleanup preselects it: [Disk Cleanup in Windows](https://support.microsoft.com/en-us/windows/disk-cleanup-in-windows-8a96ff42-5751-39ad-23d6-434b4d5b9a68) |
| W4 | `%LOCALAPPDATA%\Microsoft\Windows\Explorer\thumbcache_*.db` (and `iconcache_*.db`) | Explorer | Thumbnails are rebuilt when folders are opened again. Explorer keeps the files open while it runs, so the move usually fails as in use. | **Safe** (expect "in use") | Path: no primary source found. Disk Cleanup preselects "Thumbnails": [Disk Cleanup in Windows](https://support.microsoft.com/en-us/windows/disk-cleanup-in-windows-8a96ff42-5751-39ad-23d6-434b4d5b9a68) |
| W5 | `%LOCALAPPDATA%\CrashDumps` | WER LocalDumps (user-mode crash dumps) | Diagnostics only. Nothing breaks. | **Safe** (macOS `logs` parity) | Default `%LOCALAPPDATA%\CrashDumps`: [Collecting user-mode dumps](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps), [WER settings](https://learn.microsoft.com/en-us/windows/win32/wer/wer-settings) |
| W6 | `%LOCALAPPDATA%\Microsoft\Windows\WER\ReportArchive` and `ReportQueue` | Windows Error Reporting (per user) | Diagnostic reports. Reports still in the queue are never sent. Nothing breaks. | **Safe** | "The reports are usually saved at %localAppData%\Microsoft\Windows\WER, in 2 directories: ReportArchive … or ReportQueue": [WER for developers (Microsoft archive blog)](https://learn.microsoft.com/en-us/archive/blogs/oanapl/windows-error-reporting-wer-for-developers) |
| W7 | `%LOCALAPPDATA%\D3DSCache` | Direct3D shader cache | Shaders are recompiled, so the first launch of games and 3D apps is slower. May be locked while a GPU app runs. | **Safe** | no primary source found |
| W8 | `%LOCALAPPDATA%\NVIDIA\DXCache`, `%LOCALAPPDATA%\NVIDIA\GLCache`, `%LOCALAPPDATA%\AMD\DxCache` | GPU drivers | Same as W7 | **Safe** | no primary source found |
| W9 | `%LOCALAPPDATA%\Packages\<PFN>\TempState` | Packaged (Store/MSIX) apps | Microsoft: "could be removed at any time"; the system may delete it itself. | **Safe** | [Store and retrieve app data, Temporary app data](https://learn.microsoft.com/en-us/windows/apps/design/app-settings/store-and-retrieve-app-data) |
| W10 | `%LOCALAPPDATA%\Packages\<PFN>\LocalCache` | Packaged apps | Not a cache by contract ("not included in backup and restore"). It can hold sign-in state, offline data and settings, depending on the app. | **Review first**, per app, with the app name shown | Same page |
| W11 | `%LOCALAPPDATA%\Packages\<PFN>\LocalState`, `RoamingState`, `Settings`, `AC` | Packaged apps | App data and settings. Also where WSL distro disks live (D13). | **Never** (not listed) | Same page |

---

## 3. Browsers and Chromium/Electron apps

Chromium's own documentation: "On Windows and ChromeOS, the user cache dir is the same as the profile
dir" ([Chromium user data dir](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md)).
So on Windows the caches sit **inside** the profile, next to cookies, saved passwords (DPAPI-encrypted
`Login Data`), history and extensions. Only named cache subfolders may be offered. The profile itself is
**Never**. All of these are open while the browser or app runs, so a move fails as in use until it quits.

| # | Path | Written by | What removing it costs | Group | Source |
|---|---|---|---|---|---|
| B1 | `%LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\{Cache, Code Cache, GPUCache}` and `User Data\{ShaderCache, GrShaderCache}` | Chrome | Pages, JS bytecode and shaders are fetched or compiled again. No settings or sign-in state are lost. | **Safe** | Path: [Chromium user data dir](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md). Safe-to-delete for these exact folders: no primary source found |
| B2 | `%LOCALAPPDATA%\Microsoft\Edge\User Data\<Profile>\{Cache, Code Cache, GPUCache}` (same layout as Chrome) | Edge | Same as B1 | **Safe** | Profile path: [Edge UserDataDir policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/userdatadir). Safe-to-delete: no primary source found |
| B3 | `%APPDATA%\Code\{Cache, CachedData, Code Cache, GPUCache, logs}` | VS Code (Electron) | Rebuilt on the next start. `CachedData` is the compiled code cache. Settings (`User\`), extensions (`%USERPROFILE%\.vscode`) and `User\workspaceStorage` must stay. | **Safe** | `%APPDATA%\Code` holds user data: [VS Code uninstall](https://code.visualstudio.com/docs/setup/uninstall), [VS Code settings](https://code.visualstudio.com/docs/configure/settings). Cache subfolders: no primary source found |
| B4 | `%APPDATA%\Slack\{Cache, Code Cache, GPUCache, Service Worker\CacheStorage}` | Slack (Electron) | Re-downloaded. Sign-in lives in other files in the same root and must stay. | **Safe** | no primary source found |
| B5 | `%APPDATA%\discord\{Cache, Code Cache, GPUCache}` | Discord (Electron) | Same as B4 | **Safe** | no primary source found |
| B6 | `%LOCALAPPDATA%\Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams` (new Teams); `%APPDATA%\Microsoft\Teams` (classic) | Microsoft Teams | Microsoft documents deleting these to clear the cache. It also warns that this "deletes the diagnostic logs that are needed to find the cause". Teams must be quit first. | **Review first** | [Clear the Teams client cache](https://learn.microsoft.com/en-us/microsoftteams/troubleshoot/teams-administration/clear-teams-cache) |
| B7 | `%LOCALAPPDATA%\Mozilla\Firefox\Profiles\<p>\cache2` | Firefox (cache lives in Local; the profile lives in Roaming) | Re-downloaded | **Safe** | no primary source found (support.mozilla.org did not load for the fetcher) |
| B8 | `…\User Data` (Chrome/Edge) minus B1/B2; `%APPDATA%\Mozilla\Firefox\Profiles`; all other files in `%APPDATA%\Code`, `Slack` and `discord` | Browsers and apps | Cookies, passwords, history, sign-in and extensions are lost | **Never** | as above |

---

## 4. Package managers and toolchain caches

Paths are the tool's default and **every one can be relocated** by the variable or setting named. The
scan must ask the tool where possible (`npm config get cache`, `pnpm store path`, `go env GOCACHE`,
`dotnet nuget locals all --list`, `deno info`) or read the variable, rather than assume the default.

| # | Path (relocate with) | Written by | What removing it costs | Group | Source |
|---|---|---|---|---|---|
| P1 | `%LOCALAPPDATA%\npm-cache\_cacache` (`npm config cache`) | npm | Packages are re-downloaded on the next install. npm calls the cache "self-healing". Not locked between runs. | **Safe** | "%LocalAppData%/npm-cache on Windows": [npm folders](https://docs.npmjs.com/cli/v10/configuring-npm/folders); [npm cache](https://docs.npmjs.com/cli/v10/commands/npm-cache) |
| P2 | `%LOCALAPPDATA%\npm-cache\_npx` | npx | Packages run with `npx` are downloaded again | **Safe** | Same pages (cache root). The `_npx` subfolder: no primary source found |
| P3 | `%LOCALAPPDATA%\pnpm-cache` (`cacheDir`) | pnpm (metadata, dlx) | Metadata is fetched again | **Safe** | "Windows: ~/AppData/Local/pnpm-cache": [pnpm settings, other](https://pnpm.io/settings/other) |
| P4 | `%LOCALAPPDATA%\Yarn\Cache` | Yarn classic | "It will be populated again the next time yarn or yarn install is run" | **Safe** | Path from source: [yarn user-dirs.js](https://raw.githubusercontent.com/yarnpkg/yarn/master/src/util/user-dirs.js); [yarn cache](https://classic.yarnpkg.com/en/docs/cli/cache) |
| P5 | `%LOCALAPPDATA%\pnpm\store` (`storeDir`, `PNPM_HOME`) | pnpm content store | Every project's `node_modules` is made of **hard links** into it on Windows. Removing the store frees only files no `node_modules` still links to. Existing installs keep working (hard links keep the data), but the next install re-downloads everything. Size must be counted by file ID (section 8). | **Review first** (macOS parity) | Windows default: [pnpm settings, store](https://pnpm.io/settings/store); hard links: [pnpm FAQ](https://pnpm.io/faq) |
| P6 | Per-drive pnpm stores for projects on other drives (pnpm creates "separate stores per filesystem"; usually `<drive>:\.pnpm-store`) | pnpm | Same as P5 | **Report only** (outside the profile, so the allowed-root rule rejects it anyway) | "should be on the same drive and filesystem as installations, otherwise packages will be copied, not linked": [pnpm FAQ](https://pnpm.io/faq). The folder name: no primary source found |
| P7 | `%LOCALAPPDATA%\Yarn\Berry\cache` (`globalFolder`, `enableGlobalCache`) | Yarn 2+ | Zip archives are re-downloaded. **Never touch a per-project `.yarn\cache`**: with zero-installs it is committed to git. | **Safe** (global one only) | Windows default from source: [berry folderUtils.ts](https://raw.githubusercontent.com/yarnpkg/berry/master/packages/yarnpkg-core/sources/folderUtils.ts); [yarnrc](https://yarnpkg.com/configuration/yarnrc) |
| P8 | `%USERPROFILE%\.bun\install\cache` (`BUN_INSTALL_CACHE_DIR`) | bun | Re-downloaded. On Windows bun **hard-links** cache files into `node_modules`, so the space returned is only files with link count 1 (same as P5). | **Safe**, size labelled estimate | "Hardlinks (Linux & Windows) … Default strategy": [bun cache](https://bun.sh/docs/install/cache) |
| P9 | `%LOCALAPPDATA%\pip\Cache` (`PIP_CACHE_DIR`) | pip | Wheels and HTTP responses are fetched again | **Safe** | "%LocalAppData%\pip\Cache": [pip caching](https://pip.pypa.io/en/stable/topics/caching/) |
| P10 | `%LOCALAPPDATA%\uv\cache` (`UV_CACHE_DIR`) | uv | Re-downloaded. uv warns "it's never safe to modify the cache directly" and offers `uv cache clean`. Moving the whole folder away while no uv runs has the same effect as `uv cache clean`. Venvs hard-linked from it keep working. | **Safe** (owner to confirm; see the least-sure list) | [uv cache](https://docs.astral.sh/uv/concepts/cache/) |
| P11 | `%USERPROFILE%\.cargo\registry\cache` (`CARGO_HOME`) | cargo | `.crate` archives are re-downloaded | **Safe** | "You can remove any part of the cache and Cargo will restore sources": [Cargo home](https://doc.rust-lang.org/cargo/guide/cargo-home.html) |
| P12 | `%LOCALAPPDATA%\go-build` (`GOCACHE`) | go | Build and test results are rebuilt | **Safe** | "a subdirectory named go-build in the standard user cache directory": [cmd/go](https://pkg.go.dev/cmd/go); `%LocalAppData%`: [os.UserCacheDir](https://pkg.go.dev/os#UserCacheDir) |
| P13 | `%LOCALAPPDATA%\electron\Cache` (`electron_config_cache`) | @electron/get | Electron zips are re-downloaded on the next install | **Safe** | [electron/get](https://github.com/electron/get) |
| P14 | `%LOCALAPPDATA%\node-gyp\Cache` (`--devdir`) | node-gyp | Node headers are re-downloaded at the next native build | **Safe** | `envPaths('node-gyp',{suffix:''}).cache` in [bin/node-gyp.js](https://raw.githubusercontent.com/nodejs/node-gyp/main/bin/node-gyp.js), which on Windows is `%LOCALAPPDATA%\<name>\Cache` in [env-paths](https://raw.githubusercontent.com/sindresorhus/env-paths/main/index.js) |
| P15 | `%LOCALAPPDATA%\ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`) | Playwright | Browsers are re-downloaded with `npx playwright install`. Tests fail until then. | **Safe** (macOS parity) | "%USERPROFILE%\AppData\Local\ms-playwright": [Playwright browsers](https://playwright.dev/docs/browsers) |
| P16 | `%USERPROFILE%\.cache\puppeteer` (`PUPPETEER_CACHE_DIR`) | Puppeteer | Re-downloaded at the next install | **Safe** | `join(homedir(), '.cache', 'puppeteer')`: [getConfiguration.ts](https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer/src/getConfiguration.ts) |
| P17 | `%LOCALAPPDATA%\deno` (`DENO_DIR`) | Deno | Remote modules and npm packages are re-downloaded. `deno clean` removes this same directory. | **Safe** (macOS parity) | Windows default: [Deno installation](https://docs.deno.com/runtime/fundamentals/installation/); [deno clean](https://docs.deno.com/runtime/reference/cli/clean/) |
| P18 | `%LOCALAPPDATA%\Composer` (`COMPOSER_CACHE_DIR`) | Composer | Re-downloaded | **Safe** | "C:\Users\<user>\AppData\Local\Composer": [Composer CLI](https://getcomposer.org/doc/03-cli.md) |
| P19 | `%LOCALAPPDATA%\NuGet\v3-cache` (`NUGET_HTTP_CACHE_PATH`), `%LOCALAPPDATA%\NuGet\plugins-cache` | NuGet | HTTP responses expire after about 30 minutes anyway | **Safe** | [NuGet global packages and cache folders](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders) |
| P20 | `%USERPROFILE%\scoop\cache` (`SCOOP`) | Scoop | Installers are downloaded again on a reinstall of the same version | **Safe** | "the downloaded installers": [Scoop folder layout](https://github.com/ScoopInstaller/Scoop/wiki/Scoop-Folder-Layout); [scoop-cache.ps1](https://raw.githubusercontent.com/ScoopInstaller/Scoop/master/libexec/scoop-cache.ps1) |
| P21 | `%USERPROFILE%\.cargo\registry\src` | cargo | Re-extracted from `registry\cache`, or re-downloaded | **Review first** (macOS parity) | [Cargo home](https://doc.rust-lang.org/cargo/guide/cargo-home.html) |
| P22 | `%USERPROFILE%\.cargo\git\db`, `git\checkouts` | cargo (git dependencies) | Cloned again. Offline builds fail until then. | **Review first** | Same page |
| P23 | `%USERPROFILE%\go\pkg\mod` (`GOMODCACHE`, `GOPATH`) | go | Modules are re-downloaded. Files are read-only by design; `go clean -modcache` is the tool's own path. | **Review first** (macOS parity) | GOPATH default "%USERPROFILE%\go on Windows" and read-only modcache: [cmd/go](https://pkg.go.dev/cmd/go) |
| P24 | `%USERPROFILE%\.gradle\caches`, `%USERPROFILE%\.gradle\wrapper\dists` (`GRADLE_USER_HOME`) | Gradle | Re-downloaded and rebuilt. Files are locked while a Gradle daemon runs. | **Review first** (macOS parity) | [Gradle directory layout](https://docs.gradle.org/current/userguide/directory_layout.html) |
| P25 | `%USERPROFILE%\.m2\repository` | Maven | Re-downloaded. **Loses artifacts installed locally with `mvn install` and never published.** | **Review first** (macOS parity) | The local repository "contains temporary build artifacts that you have not yet released": [Maven repositories](https://maven.apache.org/guides/introduction/introduction-to-repositories.html) |
| P26 | `%USERPROFILE%\.nuget\packages` (`NUGET_PACKAGES`) | NuGet global-packages | Every project needs a restore. Visual Studio may need a solution reload. Locked while VS has a project open ("being used by another process"). | **Review first** | Same NuGet page |
| P27 | RubyGems user install dir (`gem env user_gemhome`) | RubyGems `--user-install` | Gems are reinstalled. Gems installed by RubyInstaller live in the Ruby install directory, outside the profile, and are not offered. | **Review first** (macOS `~/.gem` parity) | [RubyGems command reference](https://guides.rubygems.org/command-reference/). Windows path: no primary source found |
| P28 | `%LOCALAPPDATA%\vcpkg\archives` (`VCPKG_DEFAULT_BINARY_CACHE`) | vcpkg binary cache | Every port is rebuilt from source, which can take hours | **Review first** | [vcpkg binary caching](https://learn.microsoft.com/en-us/vcpkg/users/binarycaching) |
| P29 | `%USERPROFILE%\.conan2\p` (`CONAN_HOME`) | Conan 2 | Packages are re-downloaded or rebuilt. Packages built locally with `conan create` and never uploaded are lost. `conan cache clean` exists and keeps packages. | **Review first** | [Conan env vars](https://docs.conan.io/2/reference/environment.html); [conan cache](https://docs.conan.io/2/reference/commands/cache.html) |
| P30 | `%TEMP%\NuGetScratch` | NuGet | Holds the locks that coordinate NuGet processes | Not listed on its own (covered by W2; skip it while `dotnet` or `msbuild` runs) | Same NuGet page |
| P31 | winget downloads (`%TEMP%\WinGet`) | winget | Re-downloaded. winget has no cache command (its command list has none). | Covered by W2 | [winget commands](https://learn.microsoft.com/en-us/windows/package-manager/winget/); path: no primary source found |
| P32 | `C:\ProgramData\chocolatey` and its cache | Chocolatey | Needs administrator rights | **Out of scope** (section 11) | [Chocolatey setup](https://docs.chocolatey.org/en-us/choco/setup/) |

Homebrew and CocoaPods have no native Windows counterpart.

### Toolchain roots: Never (skip)

These hold installed tools. Their `node_modules`, `target` and `bin`/`obj` folders must never be offered.
This is the Windows form of `NM_TOP` / `DEV_TOP` / `REPO_SKIP`.

| # | Path (relocate with) | What it holds | Source |
|---|---|---|---|
| X1 | `%USERPROFILE%\.rustup` (`RUSTUP_HOME`), `%USERPROFILE%\.cargo\bin` | Rust toolchains | [rustup installation](https://rust-lang.github.io/rustup/installation/index.html) (`.cargo\bin` is stated; `.rustup` on Windows: no primary source found) |
| X2 | nvm-windows root (`NVM_HOME`, usually `%LOCALAPPDATA%\nvm` or `%APPDATA%\nvm`) and its `NVM_SYMLINK` target | Node versions and their global `node_modules` | no primary source found (GitHub README did not state it) |
| X3 | `%LOCALAPPDATA%\Volta` (`VOLTA_HOME`) | Node, npm and global tools | [Volta installers](https://docs.volta.sh/advanced/installers) |
| X4 | `%USERPROFILE%\.pyenv\pyenv-win` | Python versions | [pyenv-win](https://github.com/pyenv-win/pyenv-win) |
| X5 | `%USERPROFILE%\scoop\{apps, persist, shims, buckets}` | Installed apps, **persisted app data**, shims | [Scoop folder layout](https://github.com/ScoopInstaller/Scoop/wiki/Scoop-Folder-Layout) |
| X6 | `%APPDATA%\npm` (global prefix) | Global npm CLIs | "On Windows, it's %AppData%\npm": [npm folders](https://docs.npmjs.com/cli/v10/configuring-npm/folders) |
| X7 | `%USERPROFILE%\.vscode`, `%USERPROFILE%\.vscode-shared` | VS Code extensions | [VS Code uninstall](https://code.visualstudio.com/docs/setup/uninstall) |
| X8 | `%LOCALAPPDATA%\Android\Sdk` (`ANDROID_HOME`) | Android SDK | [Android env vars](https://developer.android.com/tools/variables) (Windows default path: no primary source found) |

---

## 5. Developer tools and big per-user disks

| # | Path | Written by | What removing it costs | Group | Source |
|---|---|---|---|---|---|
| D1 | `%LOCALAPPDATA%\Microsoft\VisualStudio\<ver>\ComponentModelCache` | Visual Studio (MEF cache) | Rebuilt at the next start. VS must be closed. | **Safe** | Microsoft Q&A answer (community, Microsoft-hosted): [Visual Studio 2022 clear local caches](https://learn.microsoft.com/en-us/answers/questions/1221136/visual-studio-2022-clear-local-caches) |
| D2 | `%LOCALAPPDATA%\Microsoft\VisualStudio\<ver>` other content (`privateregistry.bin`, settings, extensions) | Visual Studio | Settings and extensions are lost | **Never** | Same |
| D3 | `.vs` folder beside a `.sln` / `.slnx` | Visual Studio | Rebuilt: IntelliSense database, `.suo` (open documents, breakpoints, startup project). Those per-user settings are lost. Locked while the solution is open. | **Review first**, only when a solution file sits beside it | `.suo` holds per-user solution options: [Solution User Options (.suo) file](https://learn.microsoft.com/en-us/visualstudio/extensibility/internals/solution-user-options-dot-suo-file) |
| D4 | `%LOCALAPPDATA%\JetBrains\<product><version>` (system dir) | JetBrains IDEs | Indexes are rebuilt, but the folder also holds **Local History**, which is user data | **Review first**. Folders of IDE versions no longer installed could be Safe (owner decision) | "contains caches and local history files": [IntelliJ IDEA directories](https://www.jetbrains.com/help/idea/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html) |
| D5 | `%APPDATA%\JetBrains\<product><version>` (config, plugins) | JetBrains | Settings and plugins | **Never** | Same |
| D6 | `%LOCALAPPDATA%\JetBrains\<product><version>\log` | JetBrains | Diagnostics only | **Safe** (macOS `logs` parity) | Same |
| D7 | `%LOCALAPPDATA%\Google\<AndroidStudio><version>` | Android Studio (system dir) | Same as D4 | **Review first** | "%LOCALAPPDATA%\Google\<product><version>": [Android Studio config](https://developer.android.com/studio/intro/studio-config) |
| D8 | `%USERPROFILE%\.android\avd\*.avd` (`ANDROID_AVD_HOME`) | Android emulator | **Emulator user data**: installed apps, settings, SD card | **Review first** | "stores the device user data, such as installed apps and settings, as well as an emulated SD card": [Manage AVDs](https://developer.android.com/studio/run/managing-avds); [env vars](https://developer.android.com/tools/variables) |
| D9 | `%LOCALAPPDATA%\Unity\cache` | Unity Hub / Editor (package and asset caches) | Re-downloaded | **Review first** | no primary source found |
| D10 | Unity project `Library` beside `Assets` and `ProjectSettings` | Unity | Fully re-imported on the next open, which can take a long time | **Review first** (only with both siblings present; never by name alone) | no primary source found |
| D11 | `%LOCALAPPDATA%\UnrealEngine\Common\DerivedDataCache` | Unreal Engine (local DDC) | Shaders and cooked data are rebuilt, which can take a long time | **Review first** | no primary source found (Epic's page did not render for the fetcher) |
| D12 | Project `DerivedDataCache`, `Intermediate`, `Saved` beside a `.uproject` | Unreal | `Saved` holds autosaves and config: user data | **Report only** | no primary source found |
| D13 | WSL distro disks: `%LOCALAPPDATA%\Packages\<PFN>\LocalState\ext4.vhdx` (or the distro's `BasePath`) | WSL 2 | **Deleting destroys the distro and every file in it.** The VHD grows on demand and does not shrink when files inside are deleted (unless `sparseVhd` is on). | **Report only**, with a note on how to compact | "WSL 2 automatically resizes these VHD files"; "do not modify, move, or access the WSL related files located inside of your AppData folder using Windows tools": [WSL disk space](https://learn.microsoft.com/en-us/windows/wsl/disk-space); `sparseVhd`: [WSL config](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) |
| D14 | Docker Desktop disk: `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx` (older: `…\wsl\data\ext4.vhdx`), relocatable in Settings → Resources → Disk image location | Docker Desktop (WSL 2 backend) | Deleting destroys all images, containers and volumes. `docker system prune` frees space inside the disk; Windows gets it back only after compaction. Compacting needs `Optimize-VHD` (Hyper-V module, admin) or a sparse VHD. | **Report only**, plus the prune command in section 10 | Disk image location setting: [Docker Desktop settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/). The file name and the no-shrink behaviour: no primary source found from Docker (only blogs) |

---

## 6. Stale build output and `node_modules`

The macOS rules carry over unchanged: `node_modules` at any age (preselected over 90 days), and
`DEV_NAMES` (`.venv`, `venv`, `target` only with `Cargo.toml` beside it, `.next`, `.nuxt`, `.turbo`,
`.svelte-kit`, `.parcel-cache`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`) untouched for
90+ days, all **Safe**. On Windows, `.venv` and `venv` may be junctions or hold hard links (uv); the
reparse-point rule in section 8 covers both.

Windows-typical candidates:

| Name | Rule | Group | Why not by name alone |
|---|---|---|---|
| `bin` and `obj` | Only when a `*.csproj`, `*.fsproj` or `*.vbproj` sits in the same folder, and untouched for 90+ days | **Safe** with the project-file condition | `bin` is a common name for hand-placed tools and scripts (`%USERPROFILE%\bin`, `.cargo\bin`, `scoop\shims`). `obj` is rarer, but 3D assets use the extension. A bare name match would delete user tools. Same pattern as `target` + `Cargo.toml`. |
| `.vs` | Only beside a `.sln`/`.slnx` | **Review first** (D3) | Holds per-user solution state (`.suo`), so it is not pure build output |
| `packages` | Only beside `packages.config` (old NuGet), untouched for 90+ days | **Review first** | `packages` is the standard folder name for monorepo workspaces (`packages/*` in pnpm, yarn and npm workspaces). By name alone it would hit source code. NuGet copies packages there with `packages.config`: [NuGet folders](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders) |
| `TestResults` | Beside a test project file | **Review first** | Can hold logs people keep |
| `x64`, `Debug`, `Release` (C++ output) | Not proposed | n/a | Common names for user folders; no reliable sibling marker |

The walk must skip toolchain roots (X1 to X8) and every reparse point (section 8) when looking for these.

---

## 7. Report only and Never (protected)

### Report only

| # | Path | Group | Source |
|---|---|---|---|
| R1 | Files over 1 GB (allocated size, section 8) outside the protected folders | **Report only** (macOS parity) | n/a |
| R2 | `FOLDERID_Downloads` entries older than 180 days. The folder can be redirected, so resolve it with `SHGetKnownFolderPath`. | **Report only** (macOS parity) | [KNOWNFOLDERID](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid) |
| R3 | D12, D13, D14, P6 | **Report only** | above |

### Never (Windows counterpart of `PERSONAL` and `SYSTEM`)

All matching is case-insensitive (section 8). Known Folders must be resolved through
`SHGetKnownFolderPath` (both the local and the OneDrive-redirected path), never by name. OneDrive Known
Folder Move redirects Desktop, Documents, Pictures, Screenshots and Camera Roll into the OneDrive folder
([Redirect known folders](https://learn.microsoft.com/en-us/sharepoint/redirect-known-folders)), and
Windows Folder Redirection can point them anywhere, network shares included.

| Protected | How resolved | Why | Source |
|---|---|---|---|
| The profile root itself and every ancestor; any path outside the profile except W1 and W2 | `FOLDERID_Profile` | macOS `$HOME` rule | n/a |
| Documents, Desktop, Pictures, Music, Videos | `FOLDERID_Documents`, `_Desktop`, `_Pictures`, `_Music`, `_Videos` (current target), **plus** the default `%USERPROFILE%\<name>` path | User files | [KNOWNFOLDERID](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid) |
| The OneDrive root and everything under it, including `OneDrive - <Org>` roots and any other cloud sync root | `FOLDERID_SkyDrive` plus the sync roots registered with the cloud files API (StorageProvider) | Deleting there deletes in the cloud. Its Documents, Pictures and Camera Roll are `FOLDERID_SkyDrive*`. | [KNOWNFOLDERID](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid); [Files On-Demand](https://support.microsoft.com/en-us/office/save-disk-space-with-onedrive-files-on-demand-for-windows-0e6860d3-d9f3-4971-b321-7092438fb38e) |
| `%USERPROFILE%\.ssh`, `.gnupg`, `.aws`, `.kube`, `.azure`, `.claude`, `.docker` (config) | names under the profile | Keys, cloud credentials | macOS parity |
| `%APPDATA%\gnupg` | name | GnuPG home on Windows (Registry `HKCU\Software\GNU\GnuPG:HomeDir` can move it) | [GnuPG configuration options](https://www.gnupg.org/documentation/manuals/gnupg/Configuration-Options.html) (the default `%APPDATA%\gnupg`: no primary source found) |
| `%APPDATA%\Microsoft\Protect` | name | DPAPI master keys. Without them, every DPAPI-protected secret (browser passwords, Credential Manager, Wi-Fi) is unrecoverable. "DPAPI does not delete any expired MasterKeys. Instead, they are kept forever in the user's profile directory." | [Windows Data Protection](https://learn.microsoft.com/en-us/previous-versions/ms995355(v=msdn.10)) (exact subfolder: secondary sources only) |
| `%APPDATA%\Microsoft\Credentials`, `%LOCALAPPDATA%\Microsoft\Credentials`, `%LOCALAPPDATA%\Microsoft\Vault`, `%APPDATA%\Microsoft\Crypto`, `%APPDATA%\Microsoft\SystemCertificates` | names | Credential Manager, private keys, certificates | no primary source found for the exact paths |
| Browser profiles minus caches (B8) | as section 3 | Passwords, cookies, history | as section 3 |
| Outlook: `%LOCALAPPDATA%\Microsoft\Outlook` (`.ost`, `.pst`), `Documents\Outlook Files` (`.pst`); any `*.pst` anywhere | names plus extension | Mail. A `.pst` is often the only copy. | Default `.pst` paths: [Overview of Outlook data files](https://support.microsoft.com/en-au/office/overview-of-outlook-data-files-pst-and-ost-222eaf92-a995-45d9-bde2-f331f60e2790) (`.ost` path: secondary sources) |
| Thunderbird: `%APPDATA%\Thunderbird\Profiles` | name | Mail | no primary source found |
| Password managers: `%APPDATA%\Bitwarden`, `%LOCALAPPDATA%\1Password`, `%APPDATA%\KeePass` and `*.kdbx` anywhere | names plus extension | Vaults | no primary source found (author's list) |
| Packaged app state (W11), WSL and Docker disks (D13, D14), toolchain roots (X1 to X8) | as above | as above | as above |
| `C:\Windows`, `C:\Program Files*`, `C:\ProgramData`, `C:\$Recycle.Bin\<other SIDs>`, `System Volume Information`, other users' profiles | `FOLDERID_Windows`, `_ProgramFiles*`, `_ProgramData` | `SYSTEM` parity. Admin-owned. | [KNOWNFOLDERID](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid) |

### Temp rule translated

macOS: "anything outside HOME other than `/private/tmp` entries and the per-user `$TMPDIR` tree is
blocked". Windows:

- Allowed roots: the profile (minus the Never list), the resolved per-user temp folder (`GetTempPath2`),
  and `<drive>:\$Recycle.Bin\<own SID>` on fixed drives (W1 only).
- `GetTempPath2` returns `TMP`, else `TEMP`, else `USERPROFILE`, else **the Windows directory**
  ([GetTempPath2W](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-gettemppath2w)).
  The temp root is allowed only when it resolves inside the profile, which is the default
  `%LOCALAPPDATA%\Temp`. If it resolves to the profile root, the Windows directory or another drive, temp
  is not scanned (owner decision: allow a user-owned `TMP` on another drive?).
- Inside temp, only entries whose **owner SID** is the user's are offered (the Windows form of the
  `uid == getuid()` filter). Elevated installers leave Administrators-owned entries there.
- `C:\Windows\Temp` and `C:\Windows\SystemTemp` are admin-owned and excluded (section 11).

---

## 8. Path and filesystem facts the safety rules need

| Fact | Consequence for disk-clean | Source |
|---|---|---|
| Names are case-insensitive by default, and drive letters are too. NTFS can be made case-sensitive per directory (WSL, `fsutil file setCaseSensitiveInfo`). | Compare paths case-insensitively everywhere, using the OS comparison (`CompareStringOrdinal` with ignore-case), not ASCII lowercasing: Windows folds non-ASCII letters too. A per-directory case-sensitive tree can hold two names that compare equal; the scan record must keep the exact spelling. | "Do not assume case sensitivity…": [Naming files](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file); [per-directory case sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity) |
| 8.3 short names: `C:\Users\OMRIKA~1\…` is a second spelling of the same path. Generation can be off per volume. | Canonicalise with `GetFinalPathNameByHandleW` (or `GetLongPathNameW`) before any comparison, and reject any input path component containing `~` whose long form differs. Otherwise a protected folder can be reached by its short name. | [Naming files](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file) |
| MAX_PATH is 260; `\\?\` gives about 32,767 characters, turns off normalisation (no `/`, `.` or `..`) and needs absolute paths. Long-path opt-in needs both a registry value and an app manifest. | Use `\\?\` paths for every file call (Rust `std::fs::canonicalize` returns them). The macOS "canonical: no `.`/`..`/`//`" rule still applies, and is checked before the prefix is added. `node_modules` trees routinely pass 260. | [Maximum path length](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation) |
| NTFS has hard links (files only, same volume), junctions (directories, may cross local volumes, reparse points) and symbolic links (reparse points). | "A link is moved or removed itself, never followed" covers every reparse point. | [Hard links and junctions](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions) |
| Detection: `FILE_ATTRIBUTE_REPARSE_POINT`, then the tag (`WIN32_FIND_DATA.dwReserved0` or `FILE_ATTRIBUTE_TAG_INFO`). `IO_REPARSE_TAG_MOUNT_POINT` is both junctions and mounted volumes; `IO_REPARSE_TAG_SYMLINK`; `IO_REPARSE_TAG_CLOUD*` (OneDrive placeholders); `IO_REPARSE_TAG_APPEXECLINK` (Store app aliases). Name-surrogate bit = "represents another named entity". | Walk rule: never descend into any reparse point whose tag is a name surrogate (junction, symlink, mount point). Cloud-tagged entries are files and folders of a sync root, never offered (Never list) and never opened. | [Determining whether a directory is a mounted folder](https://learn.microsoft.com/en-us/windows/win32/fileio/determining-whether-a-directory-is-a-volume-mount-point); [reparse point tags](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-tags) |
| Hard links: one file, several names, same volume. File identity = file index (or 128-bit `FILE_ID_INFO` on ReFS) **plus** the volume serial number. | Count allocated size once per (volume serial, file ID). This is the `(dev, ino)` equivalent and the "file identity" field of the Trash record. pnpm and bun installs on Windows are hard links (P5, P8). | "The identifier (low and high parts) and the volume serial number uniquely identify a file on a single computer": [BY_HANDLE_FILE_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information) |
| Size on disk: `GetCompressedFileSizeW` returns "the actual number of bytes of disk storage used", the compressed size for compressed files and the sparse size for sparse files. | Use it (rounded up to the cluster size) as "allocated size", the `st_blocks` equivalent. Do not use `nFileSize`. VHDX disks are typically sparse or expanding. | [GetCompressedFileSizeW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getcompressedfilesizew) |
| Cloud placeholders: `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` ("not fully present locally … reading the file … will cause … content to be fetched") and `FILE_ATTRIBUTE_RECALL_ON_OPEN` (directory enumeration only; "no physical representation on the local system"); `FILE_ATTRIBUTE_OFFLINE`; `PINNED` / `UNPINNED`. | The walk reads attributes from directory enumeration only (`FindFirstFileExW` / `GetFileInformationByHandleEx(FileIdBothDirectoryInfo)`), never opens a file with either recall bit, and counts its size with `GetCompressedFileSizeW` only if that call does not trigger recall (otherwise counts 0). Online-only files take no local space. | [File attribute constants](https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants); [Files On-Demand](https://support.microsoft.com/en-us/office/save-disk-space-with-onedrive-files-on-demand-for-windows-0e6860d3-d9f3-4971-b321-7092438fb38e) |
| Files open without `FILE_SHARE_DELETE` cannot be moved, renamed or deleted; the error is `ERROR_SHARING_VIOLATION`. A directory cannot be renamed while any file in it is open that way. | New outcome "kept, in use" (user story 15). With `IFileOperation`, set `FOF_NOERRORUI` and *not* `FOFX_EARLYFAILURE`, so one locked item is skipped and the rest continue; read the per-item `HRESULT` in the progress sink. | [Creating and opening files](https://learn.microsoft.com/en-us/windows/win32/fileio/creating-and-opening-files); [SetOperationFlags](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags) |
| Each drive has its own Recycle Bin (`<drive>:\$Recycle.Bin\<SID>`). A recycle is a rename on the same volume, not a copy across drives. Network shares and most removable drives have no Recycle Bin. | Re-check the item's volume before the move. On a volume without a Recycle Bin, the shell deletes for good (next section). | [cleanmgr](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cleanmgr) ("A Recycle Bin may appear in more than one drive"); libyal (secondary) |

---

## 9. Recycle Bin mechanics

| Question | Answer | Source |
|---|---|---|
| How to recycle | `IFileOperation::DeleteItem(s)` + `PerformOperations`, with `FOFX_RECYCLEONDELETE` (Windows 8+, "send it to the Recycle Bin rather than permanently deleting it") or `FOF_ALLOWUNDO`, plus `FOFX_ADDUNDORECORD` if Explorer's Ctrl+Z should work. `FOF_NOCONFIRMATION`, `FOF_SILENT`, `FOF_NOERRORUI`. Full paths only (with `SHFileOperation`, a path without a full path is never recycled). | [SetOperationFlags](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags); [SHFILEOPSTRUCT](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shfileopstructa) |
| Where did the item land | `IFileOperationProgressSink::PostDeleteItem` receives `psiNewlyCreated`: "the deleted item, now in the Recycle Bin. If the item was fully deleted, this value is NULL." Its file-system path is the `$R…` name. Record that path and its file ID in the Trash record. | [PostDeleteItem](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperationprogresssink-postdeleteitem) |
| `$I` / `$R` pairing | Each recycled item becomes `$R<random><ext>` (the data, the same file renamed) and `$I<same random><ext>` (metadata) in `<drive>:\$Recycle.Bin\<SID>\`. `$I` records: format version (2 on Windows 10+), original size (8 bytes), deletion time (FILETIME), original path (UTF-16; v2 is length-prefixed). | [libyal Recycle.Bin format](https://raw.githubusercontent.com/libyal/dtformats/main/documentation/Windows%20Recycle.Bin%20file%20formats.asciidoc) (secondary; Microsoft does not document the format) |
| Supported way to read the metadata | Enumerate `FOLDERID_RecycleBinFolder` with the shell, read original location (`PID_DISPLACED_FROM`), deletion date (`PID_DISPLACED_DATE`) and size (`PKEY_Size`) | [How can I get information about the items in the Recycle Bin? (Raymond Chen)](https://devblogs.microsoft.com/oldnewthing/20110830-00/?p=9773) |
| Restore one item | Supported shell route: invoke the `undelete` verb on the item's context menu. Caveat: the Recycle Bin ignores `CMIC_MASK_FLAG_NO_UI` and shows a dialog "when something dangerous is about to happen, such as overwriting an existing file". For "restore without overwriting" with no UI, disk-clean's own Undo can instead rename `$R…` back to the recorded original path with `MoveFileExW` *without* `MOVEFILE_REPLACE_EXISTING` (same volume, atomic, fails if the target exists), then delete the matching `$I…`. That matches the macOS design ("our own Undo never depends on the file manager's restore"). | [Invoking verbs on Recycle Bin items (Raymond Chen)](https://devblogs.microsoft.com/oldnewthing/20110901-00/?p=9753); the rename route: author's design, no primary source |
| Remove one item for good | Delete the recorded `$R…` (recursively if it is a folder) and its `$I…`, after checking the file ID still matches the record. Shell alternative: `IFileOperation::DeleteItem` on the Recycle Bin item without recycle flags. Never `SHEmptyRecycleBin`: it empties everything. | Chen (above) warns against "recycle then purge" as a design, and says to clear `FOF_ALLOWUNDO` when permanent deletion is wanted (that is the Delete immediately mode) |
| Too large for the Recycle Bin | Each drive's bin has a cap: since Vista, 10% of the first 40 GB of quota plus 5% above that, or a policy value. An item larger than the cap cannot be recycled, and the shell deletes it **permanently**. Explorer asks "This file is too big to recycle". A program with `FOF_NOCONFIRMATION` gets no question unless it sets **`FOF_WANTNUKEWARNING`** ("Send a warning if a file or folder is being destroyed during a delete operation rather than recycled. This flag partially overrides FOF_NOCONFIRMATION."). disk-clean needs no dialog: treat `psiNewlyCreated == NULL` as "deleted for good", and avoid that case altogether by checking the size first (`SHQueryRecycleBinW` for the bin's current size; the configured cap is in `HKCU\…\Explorer\BitBucket\Volume\{GUID}\MaxCapacity`, which has no Microsoft documentation). An oversize item is kept and reported "NOT TRASHED: larger than the Recycle Bin on this drive". | Default size: [Raymond Chen on Recycle Bin size](https://devblogs.microsoft.com/oldnewthing/?p=603); flag: [SetOperationFlags](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags); [SHQueryRecycleBinW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shqueryrecyclebinw); the dialog text: secondary sources only |
| Drives without a Recycle Bin | Same outcome as "too large" (`psiNewlyCreated == NULL`). Pre-check the volume (fixed, local NTFS/ReFS) and keep the item with a reason otherwise (user story 16's Windows twin). | as above |
| Sync with Explorer | Item still at the recorded `$R` path with the same file ID: "in the Recycle Bin". Gone and the original path holds the same file ID: "put back in Explorer". Gone, and nothing with that ID at the original: "emptied". Anything else is "failed". Same logic as macOS. | design, from the spec |

---

## 10. Fixed commands (candidates only, owner decides)

macOS runs exactly three by fixed id (`xcode-unavailable-sims`, `docker-prune`, `brew-cleanup`). The
first and last have no Windows counterpart.

| Candidate id | Command | Admin? | What it removes | Undo? | Status |
|---|---|---|---|---|---|
| `docker-prune` | `docker system prune -f` | No (the user must be in `docker-users`) | "all stopped containers, all networks not used by at least one container, all dangling images, unused build cache". Volumes are not touched without `--volumes`. The space is freed **inside** `docker_data.vhdx`, and Windows sees none of it until the disk is compacted. | No | Same id as macOS. Owner decision needed. [docker system prune](https://docs.docker.com/reference/cli/docker/system/prune/) |
| `scoop-cache` | `scoop cache rm *` | No | Downloaded installers in `scoop\cache` (the same bytes as row P20) | No | Redundant with P20 as a Recycle Bin item, which *can* be undone. Proposal: do not add it. [scoop-cache.ps1](https://raw.githubusercontent.com/ScoopInstaller/Scoop/master/libexec/scoop-cache.ps1) |
| `scoop-cleanup` | `scoop cleanup *` | No | Old versions of installed Scoop apps (the analogue of `brew cleanup`) | No | Owner decision. Command list: [Scoop commands](https://github.com/ScoopInstaller/Scoop/wiki/Commands) |
| `go-modcache` | `go clean -modcache` | No | Same as P23, the tool's own way (handles the read-only files) | No | Only if moving read-only module files to the Recycle Bin proves unreliable |
| `uv-cache-clean` | `uv cache clean` | No | Same as P10, the tool's documented route | No | Only if the owner prefers the tool route for P10 |
| winget | none | n/a | winget has no cache command | n/a | n/a ([winget commands](https://learn.microsoft.com/en-us/windows/package-manager/winget/)) |
| `wsl --manage <d> --set-sparse true` / `Optimize-VHD` | | `Optimize-VHD` needs admin and Hyper-V | Compacts D13/D14 | n/a | **Not proposed**: changes a VM disk, and the admin rule rules out `Optimize-VHD` |

---

## 11. Out of scope: needs administrator rights

- Windows Update download cache: `C:\Windows\SoftwareDistribution\Download`
- Component store: `C:\Windows\WinSxS` (only `DISM /StartComponentCleanup`)
- `C:\Windows\Temp`, `C:\Windows\SystemTemp`
- `hiberfil.sys` (`powercfg /h off`), `pagefile.sys`, `swapfile.sys`
- System Restore points and shadow copies (`System Volume Information`)
- Delivery Optimization cache (`C:\Windows\ServiceProfiles\NetworkService\…\DeliveryOptimization`)
- Chocolatey (`C:\ProgramData\chocolatey`, its lib and cache) ([Chocolatey setup](https://docs.chocolatey.org/en-us/choco/setup/))
- Other users' profiles and their `$Recycle.Bin\<SID>` folders
- WER machine-wide queues under `C:\ProgramData\Microsoft\Windows\WER`
- `Windows.old`

The Storage tab should still show these as "system, needs administrator" in the reconciliation, the way
macOS shows the system volume and APFS reserve.

---

## 12. Owner decisions this list needs

1. `%TEMP%`: Review first only (macOS parity), or preselect entries idle 7+ days (Microsoft's Disk
   Cleanup rule)?
2. Thumbnail cache (W4) and browser caches (B1, B2, B7): Safe, knowing they are usually in use, or Report
   only?
3. uv (P10) and Deno (P17): Safe by macOS parity, or Review first?
4. JetBrains and Android Studio folders of versions no longer installed: Safe?
5. The Docker prune command on Windows: keep it, given the space stays inside the VHDX until compaction?
6. A `TMP` that points outside the profile: scan it (user-owned entries only) or skip it?

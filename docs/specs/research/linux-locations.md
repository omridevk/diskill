# disk-clean on Linux: locations proposal

Draft 2026-10-05 for the owner's review. Answers open question 1 of
`docs/specs/cross-platform.md` for Linux. Nothing here is ruled; every group is a proposal.

Read against the macOS code at the time of writing: `cli/src/scan.rs` (tables `PKG_CACHE`,
`PKG_CACHE_TAIL`, `PKG_STORE`, `PNPM_STORE`, the `scan_*` functions and their `Cat` risk/pre values),
`cli/src/walk.rs` (`NM_TOP`, `DEV_TOP`, `DEV_NAMES`, `REPO_SKIP`) and `cli/src/clean.rs` (`PERSONAL`,
`SYSTEM`, `is_protected`, `in_allowed_root`, `COMMANDS`).

## How to read the tables

Groups, mapped to the macOS `risk`/`pre` values:

| Group | macOS equivalent | Meaning |
|---|---|---|
| **Safe** | `risk: safe`, `pre: 1` | Listed and preselected. |
| **Review first** | `risk: review`, `pre: 0` | Listed, not preselected. |
| **Report only** | `risk: report` | Shown with a disabled checkbox, never deletable through the tool. |
| **Never** | `PERSONAL` / `SYSTEM` in `clean.rs` | Hard-blocked in `is_allowed`, whatever the selection. |
| **Not listed** | (no macOS row) | The scan emits no row for it, but it is not on the hard-block list, because a listed row lives inside it (example: `~/.local/share` holds the pnpm store and the Trash). Also excluded from the `node_modules` / build-artifact / repo searches where marked. This fifth label is new; the owner may prefer to fold it into Never. |

Path notation: `$XDG_CACHE_HOME` defaults to `~/.cache`, `$XDG_DATA_HOME` to `~/.local/share`,
`$XDG_CONFIG_HOME` to `~/.config`, `$XDG_STATE_HOME` to `~/.local/state` (basedir spec 0.8). "Ignores
XDG" means the tool uses a fixed dot-folder in `$HOME` whatever the XDG variables say.

"Source" cells cite pages fetched on 2026-10-05. Where a claim in column 3 is my inference rather than
the tool's own statement, the cell says "inference".

## 1. XDG base directories

| # | Path | Written by | When removed | Group | Source |
|---|---|---|---|---|---|
| 1.1 | `$XDG_CACHE_HOME/*` (each child, default `~/.cache/*`), except the children named in section 2 | Any XDG-aware program. Spec: "user-specific non-essential data files". | Spec and UAPI: flushing "should have no effect on operation of programs, except for increased runtimes necessary to rebuild these caches". Section 2 lists well-known children that break this promise. | Safe: the closest match to `~/Library/Caches`, which is Safe on macOS, as long as the exceptions in section 2 are carved out first. | https://specifications.freedesktop.org/basedir/latest/ ; https://uapi-group.org/specifications/specs/linux_file_system_hierarchy/ |
| 1.2 | `$XDG_DATA_HOME` (`~/.local/share`) as a whole | Apps: user data, installed apps (Flatpak), keyrings, Trash, toolchains (uv, pnpm global). | Data loss: the spec calls it "user-specific data files". | Not listed: only the named rows inside it (Trash, pnpm store, Flatpak caches) are offered. | https://specifications.freedesktop.org/basedir/latest/ |
| 1.3 | `$XDG_CONFIG_HOME` (`~/.config`) as a whole | App configuration. In practice also Chromium/Electron profiles with cookies and logins, and credentials (gh, gcloud). | Loses settings and login state. UAPI: apps "should fall back to defaults", which is not true of the credentials in it. | Not listed: only the Electron cache rows in section 4 are offered, as Review first. | https://uapi-group.org/specifications/specs/linux_file_system_hierarchy/ ; https://www.electronjs.org/docs/latest/api/app#appgetpathname |
| 1.4 | `$XDG_STATE_HOME` (`~/.local/state`) | Apps. Spec: "actions history (logs, history, recently used files, …)" and "current state of the application". | Loses history, undo history and window state. Logs are mixed in with state, so there is no clean "Logs" folder to offer as there is on macOS. | Not listed: logs and state share one folder, so it cannot be offered as a whole. | https://specifications.freedesktop.org/basedir/latest/ |
| 1.5 | `$XDG_RUNTIME_DIR` (usually `/run/user/$UID`) | Session services: sockets, pipes, keyring and Docker sockets. | Spec: it must be 0700, bound to the login and gone on logout or reboot. Removing it under a live session breaks running services. | Never: live session state, and it is outside `$HOME`. | https://specifications.freedesktop.org/basedir/latest/ ; https://uapi-group.org/specifications/specs/linux_file_system_hierarchy/ |

## 2. Children of `~/.cache` that are not plain disposable cache

These are carved out of row 1.1 before it is applied.

| # | Path | Written by | When removed | Group | Source |
|---|---|---|---|---|---|
| 2.1 | `~/.cache/disk-clean` | disk-clean itself: run directories and the Trash record `trashed.jsonl`. | Undo and Empty lose their record. Items already in the Trash stay there but are orphaned for the tool. | Never: the tool's own state. On macOS it is outside `~/Library/Caches`, so the problem does not arise there. | `SKILL.md` "Stage 3" and "Re-running" |
| 2.2 | `$HF_HOME/token`, `$HF_HOME/stored_tokens` (`HF_HOME` defaults to `$XDG_CACHE_HOME/huggingface`) | `huggingface_hub` login. | HF docs: `HF_TOKEN_PATH` "Defaults to `$HF_HOME/token` (e.g. `~/.cache/huggingface/token`)". Removing it logs the user out of the Hub, and gated or private models stop downloading. | Never: login state inside the cache folder. | https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables |
| 2.3 | `$HF_HUB_CACHE/*` (default `~/.cache/huggingface/hub`, one entry per `models--…` / `datasets--…`) | `huggingface_hub`, `transformers`, `datasets`, `diffusers`. | Re-downloaded on next use, often many GB. Offline use breaks until then. A gated model needs the token again. Shared Xet blobs under `hub/blobs` are symlink targets of several repos. | Review first: expensive to restore and needs network and login. List per repo entry, never the whole `huggingface` folder (row 2.2). | https://huggingface.co/docs/huggingface_hub/guides/manage-cache |
| 2.4 | `~/.cache/huggingface/xet` | `hf_xet` upload shard cache and staging. | HF docs: "simply remove the `xet` cache entirely". An interrupted upload loses its resume state. | Safe: the upstream docs say to remove it to reclaim space. | https://huggingface.co/docs/huggingface_hub/guides/manage-cache |
| 2.5 | `~/.cache/huggingface/assets` | Downstream HF libraries: "preprocessed data, files downloaded from GitHub, logs". | Contents are library-defined, so it may hold processed datasets that are slow to rebuild. | Review first: what is inside is not specified. | https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables |
| 2.6 | `$TORCH_HOME/hub` (default `$XDG_CACHE_HOME/torch/hub`) | PyTorch Hub model checkpoints. | Re-downloaded on next `torch.hub.load`, which can be large and needs network. | Review first: model weights, expensive to restore. | https://github.com/pytorch/pytorch/blob/main/torch/hub.py (lines 89-91, 184-191, 431-432) |
| 2.7 | `~/.cache/pypoetry/virtualenvs` | Poetry: `virtualenvs.path` defaults to `{cache-dir}/virtualenvs`. | Every Poetry project loses its environment until `poetry install`. This is not a cache. | Review first: like `.venv` it can be rebuilt, but it is in active use regardless of age. | https://python-poetry.org/docs/configuration/ |
| 2.8 | `~/.cache/pypoetry/{cache,artifacts}` | Poetry download cache. | Re-downloaded. | Safe: a download cache. | https://python-poetry.org/docs/configuration/ |
| 2.9 | `~/.cache/JetBrains/<product><version>` | JetBrains IDE "system directory", including logs at `…/log`. | JetBrains: it "contains caches and local history files". Local History, the IDE's own undo history, is lost. Indexes rebuild slowly on next open. | Review first: user data (Local History) is mixed in with the caches. Old product versions are the useful targets. | https://www.jetbrains.com/help/idea/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html |
| 2.10 | `~/.cache/bazel` (`outputUserRoot` `~/.cache/bazel/_bazel_$USER`) | Bazel install base, output bases, external repos and action cache. | The next build re-fetches and rebuilds everything; `bazel-*` symlinks in workspaces dangle until then. Upstream's own command is `bazel clean --expunge`. | Review first: large and slow to rebuild, and in use by every Bazel workspace. | https://bazel.build/remote/output-directories |
| 2.11 | `~/.cache/google-chrome/*`, `~/.cache/chromium/*` | Chrome/Chromium disk cache. The profile is in `~/.config/google-chrome`. | Pages load slower until the cache refills. Logins live in the profile, not here. | Safe: Chromium's documented cache directory, separate from the profile. | https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md |
| 2.12 | `~/.cache/mozilla/firefox/*` (legacy layout), Firefox 147+ XDG cache | Firefox disk cache. | Slower loads; the profile is not affected. | Safe: the cache half of Firefox's split. | https://bugzilla.mozilla.org/show_bug.cgi?id=259356 (XDG support, fixed in Firefox 147). No primary source found for the legacy `~/.cache/mozilla` path itself. |
| 2.13 | `$XDG_CACHE_HOME/thumbnails` | File managers, per the freedesktop thumbnail spec. | Thumbnails regenerate when folders are opened again. | Safe: regenerated on demand. | https://specifications.freedesktop.org/thumbnail/latest/ (only the table of contents was retrievable; it has a section "Deleting Thumbnails" I could not read) |
| 2.14 | `~/.cache/mesa_shader_cache` (and `_db` variants) | Mesa GL/Vulkan drivers. | Shaders recompile, so games may stutter at first. Capped at 1 GB per architecture by default. | Safe: rebuilt automatically, and bounded. | https://docs.mesa3d.org/envvars.html |
| 2.15 | `$XDG_CACHE_HOME/fontconfig` | fontconfig. | Rebuilt automatically or by `fc-cache`. Small. | Safe: regenerated. Usually under the 10 MB floor anyway. | https://man.archlinux.org/man/fonts-conf.5 |
| 2.16 | `~/.cache/ccache` | ccache compiler cache. | Builds lose their speedup until refilled. Upstream's `ccache -C` clears the cache "but keeping the configuration file". Moving the whole folder also moves a `ccache.conf` kept there. | Safe for the cache. Inference: offering the folder's children except `ccache.conf` matches `ccache -C`. | https://ccache.dev/manual/latest.html |
| 2.17 | `~/.cache/pre-commit` | pre-commit hook repositories and environments. | Re-created on the next commit, which needs network. | Safe: upstream documents it as a cache directory. | https://pre-commit.com/ ("Managing CI Caches") |
| 2.18 | `~/.cache/node/corepack` (`COREPACK_HOME`) | Corepack: the downloaded package-manager binaries (yarn, pnpm). | Re-downloaded on next use; offline use of the pinned package manager breaks until then. | Safe: download cache, equivalent to the package-manager caches. | https://github.com/nodejs/corepack (Environment variables) |

## 3. Package-manager caches and stores

The macOS row is the `scan.rs` table it comes from.

| # | Path (Linux) | macOS row | Written by | When removed | Group | Source |
|---|---|---|---|---|---|---|
| 3.1 | `~/.npm/_cacache` (ignores XDG) | `PKG_CACHE` `.npm/_cacache` | npm | npm: "strictly a cache"; refetched automatically. | Safe: same as macOS. | https://docs.npmjs.com/cli/v11/commands/npm-cache |
| 3.2 | `~/.npm/_npx` | none | npx package installs | Re-downloaded on the next `npx`. npm manages it with `npm cache npx rm`. | Safe: new on Linux and on macOS alike, so it needs the owner's decision. | https://docs.npmjs.com/cli/v11/commands/npm-cache |
| 3.3 | `$XDG_CACHE_HOME/pnpm` (`~/.cache/pnpm`) | `PKG_CACHE` `Library/Caches/pnpm` | pnpm metadata cache, dlx cache | Refetched. | Safe: same as macOS. | https://github.com/pnpm/pnpm.io/blob/main/docs/settings/other.md (`cacheDir`) |
| 3.4 | `$XDG_DATA_HOME/pnpm/store` (`~/.local/share/pnpm/store`) | `PNPM_STORE` | pnpm content-addressable store | On Linux pnpm's `auto` import "tries hardlinking before cloning". Existing `node_modules` files are hard links to store files, so inference: they keep working, but deleting the store frees only blocks no `node_modules` still links. The next install re-downloads everything. `pnpm store prune` is the upstream way to reclaim unreferenced packages. | Review first: same as macOS, but the note changes; see section 9. | https://pnpm.io/settings/store ; https://github.com/pnpm/pnpm.io/blob/main/docs/settings/node-modules.md ; https://pnpm.io/cli/store |
| 3.5 | `$XDG_DATA_HOME/pnpm` other than `store` (`global`, binaries) | none | pnpm global packages | Global CLIs disappear. | Not listed: installed software. | https://github.com/pnpm/pnpm.io/blob/main/docs/settings/other.md (`globalDir`) |
| 3.6 | `$XDG_CACHE_HOME/yarn` (`~/.cache/yarn`) | `PKG_CACHE_TAIL` `.cache/yarn`, `PKG_CACHE` `Library/Caches/Yarn` | Yarn classic | Re-downloaded. | Safe: same as macOS. | https://github.com/yarnpkg/yarn/blob/master/src/util/user-dirs.js |
| 3.7 | `~/.yarn/berry/cache` (ignores XDG; `globalFolder` `${HOME}/.yarn/berry`) | `PKG_CACHE` | Yarn 2+ global cache / mirror | Re-downloaded. A project's own `.yarn/cache` (zero-installs, often committed) is a different folder and never offered. | Safe: same as macOS. | https://yarnpkg.com/configuration/yarnrc |
| 3.8 | `~/.bun/install/cache` (ignores XDG; `BUN_INSTALL_CACHE_DIR`) | `PKG_CACHE` | Bun | Re-downloaded. On Linux Bun "defaults to using hardlinks" into `node_modules`, so inference: it frees less than its size while projects link it. | Safe: same as macOS, with the size marked as an estimate. | https://bun.com/docs/install/cache |
| 3.9 | `$XDG_CACHE_HOME/pip` (`~/.cache/pip`) | `PKG_CACHE` `.cache/pip` | pip | `pip cache purge` clears it; packages are re-downloaded and rebuilt. | Safe: same as macOS. | https://pip.pypa.io/en/stable/topics/caching/ |
| 3.10 | `$XDG_CACHE_HOME/uv` (`~/.cache/uv`) | `PKG_CACHE` `.cache/uv` | uv | uv docs: "it's never safe to modify the cache directly" and point to `uv cache clean`. Inference: moving the whole folder while no uv process runs has the effect of `uv cache clean`. With `link-mode = symlink`, uv says clearing the cache "will break all installed packages". | Safe: same as macOS. Section 10 lists it as uncertain. | https://docs.astral.sh/uv/concepts/cache/ ; https://docs.astral.sh/uv/reference/settings/#link-mode |
| 3.11 | `$XDG_DATA_HOME/uv` (`~/.local/share/uv`: managed Pythons, tools) | none | uv | uv: "persistent data directory … non-disposable". Venvs that point at a managed Python break. | Not listed: a toolchain root. | https://docs.astral.sh/uv/reference/storage/ |
| 3.12 | `~/.cargo/registry/cache` (ignores XDG; `CARGO_HOME`) | `PKG_CACHE_TAIL` | Cargo: `.crate` archives | Cargo: "you can always remove any part of the cache"; re-downloaded. | Safe: same as macOS. | https://doc.rust-lang.org/cargo/guide/cargo-home.html |
| 3.13 | `~/.cargo/registry/src` | `PKG_STORE` | Cargo: unpacked sources | Re-extracted from `registry/cache`, or re-downloaded if that is gone too. | Review first: same as macOS. | https://doc.rust-lang.org/cargo/guide/cargo-home.html |
| 3.14 | `~/.cargo/git/db`, `~/.cargo/git/checkouts` | none | Cargo git dependencies | Re-cloned on the next build. | Review first: new, and it needs the owner's decision. Same restore cost as `registry/src`. | https://doc.rust-lang.org/cargo/guide/cargo-home.html |
| 3.15 | `~/.cargo/bin` | none (`.cargo` is in `DEV_TOP` and `REPO_SKIP`) | `cargo install`, rustup proxies | Installed CLIs and rustup proxies disappear. | Not listed: installed software. | https://doc.rust-lang.org/cargo/guide/cargo-home.html |
| 3.16 | `$XDG_CACHE_HOME/go-build` (`os.UserCacheDir()`) | `PKG_CACHE_TAIL` `Library/Caches/go-build` | Go build cache | `go clean -cache` removes it; rebuilt. | Safe: same as macOS. | https://pkg.go.dev/cmd/go ; https://pkg.go.dev/os#UserCacheDir |
| 3.17 | `$GOMODCACHE` (default `~/go/pkg/mod`; ignores XDG) | `PKG_STORE` | Go module cache | Re-downloaded. Go makes its directories "read-only"; upstream removal is `go clean -modcache`. Trash Empty and Delete immediately must make directories writable first, or use that command (section 7). | Review first: same as macOS. | https://pkg.go.dev/cmd/go |
| 3.18 | `~/go/bin` | none | `go install` | Installed CLIs disappear. | Not listed: installed software. | https://pkg.go.dev/cmd/go |
| 3.19 | `~/.gradle/caches` (`GRADLE_USER_HOME`; ignores XDG) | `PKG_STORE` | Gradle | Re-downloaded and rebuilt. Gradle also self-cleans entries unused for 7 to 30 days. | Review first: same as macOS. | https://docs.gradle.org/current/userguide/directory_layout.html |
| 3.20 | `~/.gradle/wrapper/dists` | none | Gradle Wrapper | Gradle distributions re-download on the next `./gradlew`; unused ones are already "deleted after 30 days of inactivity". | Review first: new, and it needs the owner's decision. | https://docs.gradle.org/current/userguide/directory_layout.html |
| 3.21 | `~/.m2/repository` (ignores XDG) | `PKG_STORE` | Maven | Maven: a cache of downloads that also "contains temporary build artifacts" from `mvn install`. Those local-only artifacts are lost; erase it "if you are willing to download everything again". | Review first: same as macOS. The note should add that local `mvn install` output is lost. | https://maven.apache.org/guides/introduction/introduction-to-repositories.html |
| 3.22 | `Gem.user_dir`: `~/.gem/<engine>/<ver>` if `~/.gem` exists, else `$XDG_DATA_HOME/gem/…` | `PKG_STORE` `.gem` | RubyGems `--user-install` | These are installed gems, executables included, not a cache. Bundler projects reinstall; global CLIs vanish. `gem cleanup --user-install` removes only old versions. | Review first: same as macOS. The note should say "installed gems". | https://github.com/rubygems/rubygems/blob/master/lib/rubygems/defaults.rb (`user_dir`, `data_home`) ; https://guides.rubygems.org/command-reference/ |
| 3.23 | `~/.gem/specs` or `$XDG_CACHE_HOME/gem/specs` | none | RubyGems spec cache | Refetched. | Safe: download metadata. The XDG variant already falls under row 1.1. | https://github.com/rubygems/rubygems/blob/master/lib/rubygems/defaults.rb (`default_spec_cache_dir`) |
| 3.24 | `$XDG_CACHE_HOME/composer` on XDG systems, else `~/.composer/cache` | `PKG_CACHE_TAIL` `.composer/cache` | Composer | Re-downloaded; upstream `composer clear-cache`. | Safe: same as macOS. | https://getcomposer.org/doc/03-cli.md |
| 3.25 | `DENO_DIR`, default `$XDG_CACHE_HOME/deno` | `PKG_CACHE_TAIL` `Library/Caches/deno` | Deno | `deno clean` "removes Deno's global module cache directory"; re-downloaded. | Safe: same as macOS. | https://docs.deno.com/runtime/reference/cli/clean/ . No primary source verified for the Linux default path: the docs pages I fetched did not state it, and a search result attributed `$HOME/.cache/deno` to docs.deno.com. |
| 3.26 | `$XDG_CACHE_HOME/electron` (`~/.cache/electron`) | `PKG_CACHE_TAIL` `Library/Caches/electron` | `@electron/get` | Re-downloaded on the next Electron install. | Safe: same as macOS. | https://github.com/electron/get |
| 3.27 | `$XDG_CACHE_HOME/node-gyp` (env-paths `cache`, `suffix: ''`) | `PKG_CACHE_TAIL` `Library/Caches/node-gyp` | node-gyp | Node headers re-download on the next native build. | Safe: same as macOS. | https://github.com/nodejs/node-gyp/blob/main/bin/node-gyp.js (line 25) ; https://github.com/sindresorhus/env-paths |
| 3.28 | `PLAYWRIGHT_BROWSERS_PATH`, default `$XDG_CACHE_HOME/ms-playwright` | `PKG_CACHE_TAIL` | Playwright | Browsers are not downloaded at run time: tests fail until `npx playwright install`. | Safe: same as macOS. Section 10 lists it as uncertain. | https://playwright.dev/docs/browsers ; https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/registry/index.ts (lines 379, 394) |
| 3.29 | `PUPPETEER_CACHE_DIR`, default `~/.cache/puppeteer` (ignores XDG: `join(homedir(), '.cache', 'puppeteer')`) | `PKG_CACHE_TAIL` | Puppeteer | Chrome for Testing (about 282 MB on Linux) is downloaded by the package's install script; after removal it comes back only via `npx puppeteer browsers install` or a reinstall. | Safe: same as macOS. | https://pptr.dev/guides/installation ; https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer/src/getConfiguration.ts (lines 162-165) |
| 3.30 | `brew --cache`, default `~/.cache/Homebrew` on Linux | `PKG_CACHE` + `probe_brew` | Homebrew on Linux | Bottles re-download; `brew cleanup --prune=all` does the same. | Safe: same as macOS. | https://docs.brew.sh/Manpage |
| 3.31 | Homebrew prefix `/home/linuxbrew/.linuxbrew` | none | Homebrew on Linux | Every brew-installed program goes. | Not listed: outside `$HOME`, so already blocked by the allowed-root rule; cleanup only through `brew cleanup` (section 7). | https://docs.brew.sh/Homebrew-on-Linux |
| 3.32 | CocoaPods, Xcode (`XCODE`, `XCODE_ARCHIVES`, `SIM_DEVICES`), iOS backups, `CRASH_REPORTER`, `DIAGNOSTIC_REPORTS`, code-sign clones | those macOS rows | Apple tools | n/a | No Linux equivalent: the rows are dropped on Linux. Android takes Xcode's place (rows 4.5 to 4.7). | n/a |

## 4. IDEs, editors, Electron apps, SDKs, toolchains

| # | Path | Written by | When removed | Group | Source |
|---|---|---|---|---|---|
| 4.1 | `~/.config/<App>/{Cache,Code Cache,GPUCache}` for Electron apps | Electron `sessionData` (default = `userData` = `$XDG_CONFIG_HOME/<App>`): "localStorage, cookies, disk cache, … compiled GPU shaders". | The disk-cache subfolders refill. The same parent holds cookies and localStorage, so only the named cache subfolders may go. The app should be closed. | Review first: new, and it needs the owner's decision. macOS does not offer the matching `Application Support/<App>/Cache` folders either. | https://www.electronjs.org/docs/latest/api/app#appgetpathname |
| 4.2 | `~/.config/Code/{Cache,CachedData,Code Cache,GPUCache}` (VS Code) | VS Code (Electron); its settings are at `~/.config/Code/User`. | Same as 4.1. | Review first: same reason as 4.1. | https://code.visualstudio.com/docs/configure/settings ; https://www.electronjs.org/docs/latest/api/app#appgetpathname |
| 4.3 | `~/.vscode/extensions` | VS Code | Every extension must be reinstalled. | Not listed: installed software (`.vscode` is already in `NM_TOP`). | https://code.visualstudio.com/docs/configure/extensions/extension-marketplace |
| 4.4 | `~/.local/share/JetBrains/<product>` (plugins), `~/.config/JetBrains/<product>` (settings) | JetBrains IDEs | Plugins and settings lost. | Not listed: installed software and settings. Old version folders could be Review first later. | https://www.jetbrains.com/help/idea/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html |
| 4.5 | `ANDROID_HOME`, Android Studio default `~/Android/Sdk` | Android Studio / sdkmanager | Platforms, build tools and system images re-download; builds fail until then. | Report only: many GB and a toolchain, not a cache. | https://developer.android.com/tools/variables (variable). No primary source verified for the `~/Android/Sdk` default (seen only in a search summary). |
| 4.6 | `ANDROID_AVD_HOME`, default `~/.android/avd` | Android Emulator | Emulator devices and their data (installed apps, state) are lost; they must be re-created. | Review first: the Xcode-simulator analogue, but there is no "unavailable" signal, so nothing is preselected. | https://developer.android.com/tools/variables |
| 4.7 | `~/.android` other than `avd` (`ANDROID_USER_HOME`) | Android SDK tools: preferences, ADB key | Device authorisations are lost. | Never: holds the ADB key; no primary source verified for `adbkey` living there. | https://developer.android.com/tools/variables |
| 4.8 | `NVM_DIR`: `~/.nvm`, or `$XDG_CONFIG_HOME/nvm` when `XDG_CONFIG_HOME` is set | nvm | Every Node version and its global CLIs disappear. | Not listed, and excluded from searches. `walk.rs` lists `.nvm` but not `~/.config/nvm`; both should be in `NM_TOP`/`DEV_TOP`. | https://github.com/nvm-sh/nvm (README, install section, lines 120-126) |
| 4.9 | `RUSTUP_HOME`, default `~/.rustup` | rustup | Toolchains re-download; builds fail until then. | Not listed, and excluded from searches (already in `NM_TOP`/`REPO_SKIP`). | https://rust-lang.github.io/rustup/environment-variables.html |
| 4.10 | `PYENV_ROOT`, conventionally `~/.pyenv` | pyenv | Python versions and their venvs break. | Not listed, and excluded from searches (already in `DEV_TOP`). | https://github.com/pyenv/pyenv (README) |
| 4.11 | `ASDF_DATA_DIR`, default `~/.asdf` | asdf | Installed tool versions disappear. | Not listed, and excluded from searches (already listed). | https://asdf-vm.com/manage/configuration.html |
| 4.12 | `~/.volta` | Volta | Node toolchain and global CLIs disappear. | Not listed, and excluded from searches (already listed). | No primary source found for the default path (README links only to guides). |
| 4.13 | `~/.sdkman` | SDKMAN! | JDKs, Gradle and Maven versions disappear. | Not listed, and excluded from searches. New to the lists: add to `DEV_TOP`/`REPO_SKIP`. | No primary source found for the default path. |
| 4.14 | `~/.local` (bin, lib, share, state) | pipx, uv tools, pip `--user`, many apps | Installed software and app data. | Not listed, and excluded from searches (already listed). Only the named rows inside it are offered. | https://uapi-group.org/specifications/specs/linux_file_system_hierarchy/ |

## 5. Linux-only user-owned space

| # | Path | Written by | When removed | Group | Source |
|---|---|---|---|---|---|
| 5.1 | `$XDG_DATA_HOME/Trash/files/*` with each one's `info/<name>.trashinfo` | Every freedesktop file manager, and disk-clean on Linux. | Permanently removed. The `.trashinfo` must go with its item, and `directorysizes` may need updating. Items disk-clean recorded must be marked emptied. | Safe: same as macOS `.Trash`. | https://specifications.freedesktop.org/trash/latest/ |
| 5.2 | Per-volume trash `$topdir/.Trash/$uid/` and `$topdir/.Trash-$uid/` on other mounted volumes | File managers trashing files from other volumes. | Same as 5.1. | Review first: user-owned but outside `$HOME`, so it needs a new allowed root; the owner's decision. | https://specifications.freedesktop.org/trash/latest/ |
| 5.3 | `~/.var/app/<app-id>/cache` | Flatpak apps: the sandbox sets `XDG_CACHE_HOME` there. | The app rebuilds it, as for row 1.1. | Safe: it is the app's `$XDG_CACHE_HOME`. Section 2's exceptions apply inside it too (for example a Flatpak app's own Hugging Face token). | https://docs.flatpak.org/en/latest/conventions.html |
| 5.4 | `~/.var/app/<app-id>/{data,config}` and other contents, for example `~/.var/app/org.mozilla.firefox/.mozilla` | Flatpak apps | App data, profiles and logins lost. | Never: same class as `~/.config` profiles. | https://docs.flatpak.org/en/latest/conventions.html |
| 5.5 | `~/.var/app/<app-id>` of an app no longer installed (neither user nor system installation) | Left behind: `flatpak uninstall` keeps app data unless `--delete-data`. | That app's data is lost for good if it is reinstalled later. | Review first: often large leftovers, but it is user data. | https://man.archlinux.org/man/flatpak-uninstall.1 |
| 5.6 | `~/.local/share/flatpak` (per-user installation: apps, runtimes, repo) | `flatpak --user` | Installed apps and runtimes disappear. Deleting files directly would corrupt the OSTree repo. | Report only: show the size; reclaim only through `flatpak uninstall --unused --user` (section 7). | https://man.archlinux.org/man/flatpak-uninstall.1 ; https://docs.flatpak.org/en/latest/flatpak-command-reference.html |
| 5.7 | `~/snap/<snap>/<revision>` for the current revision (`current` symlink), and `~/snap/<snap>/common` | Snaps: `HOME` is "re-written to `SNAP_USER_DATA`" for strict snaps. | App data, profiles and logins lost (for example the Firefox snap profile). | Never | https://snapcraft.io/docs/reference/development/environment-variables/ ; https://snapcraft.io/docs/reference/administration/data-locations/ |
| 5.8 | `~/snap/<snap>/<revision>` for a non-current revision | snapd copies `SNAP_USER_DATA` into a new folder at each refresh and keeps old ones for `refresh.retain` (2 on classic). | `snap revert` to that revision would come back without that revision's user data. | Review first: rollback data. Section 10 lists it as uncertain. | https://snapcraft.io/docs/explanation/how-snaps-work/revisions/ ; https://snapcraft.io/docs/how-to-guides/manage-snaps/manage-updates/ |
| 5.9 | `~/snap/<snap>/{current,common}/.cache` | Snap apps writing to `$HOME/.cache`, which is remapped. | Inference from the `HOME` remap plus the XDG default: it behaves like row 1.1 for that app. | Safe, with section 2's exceptions applied inside. Section 10 lists it as uncertain. | https://snapcraft.io/docs/reference/development/environment-variables/ ; https://specifications.freedesktop.org/basedir/latest/ |
| 5.10 | `~/.local/share/docker` (rootless Docker data root) | Rootless dockerd | All images, containers and volumes lost. Files belong to subordinate UIDs, so the user cannot move or delete them directly; Docker's own instructions use `rootlesskit rm -rf ~/.local/share/docker`. | Report only: only `docker system prune` can reclaim it (section 7). | https://docs.docker.com/engine/security/rootless/ ; https://docs.docker.com/engine/security/rootless/troubleshoot/ |
| 5.11 | `$XDG_DATA_HOME/containers/storage` (rootless Podman/Buildah graphroot) | Podman, Buildah, Skopeo | Same as 5.10: subordinate-UID-owned files; Podman points at `podman unshare` "for manually clearing storage". | Report only, for the same reason as 5.10. | https://github.com/containers/storage/blob/main/docs/containers-storage.conf.5.md ; https://docs.podman.io/en/latest/markdown/podman-unshare.1.html |
| 5.12 | Docker Desktop for Linux VM disk (under `~/.docker/desktop`) | Docker Desktop: "runs a Virtual Machine" with its own storage. | All Docker Desktop images, containers and volumes lost. Pruning frees space inside the image, as on macOS. | Report only | https://docs.docker.com/desktop/setup/install/linux/ . No primary source found for the disk-image path. |
| 5.13 | `~/.local/share/Steam` (also reached via `~/.steam/root`; Debian package `~/.steam/debian-installation`) | Steam client: `steamapps/common` games, shader cache, workshop. | Games re-download (many GB). Saves not in Steam Cloud can be lost. | Report only: large, and it may hold the only copy of saves. | No primary source found (community and third-party pages only). |
| 5.14 | Core files named `core` or `core.<pid>` in a process's working directory | The kernel, when `core_pattern` is a plain file name. | Debugging data only. | Review first, only for a regular file whose ELF header says it is a core file (`e_type == ET_CORE`); a name match alone could hit a source folder or file called `core`. | https://man7.org/linux/man-pages/man5/core.5.html |
| 5.15 | `/var/lib/systemd/coredump/*` | systemd-coredump | n/a: the directory is `root root` and aged after 2 weeks. | Out of scope (root). | https://man.archlinux.org/man/systemd-coredump.8 ; https://github.com/systemd/systemd/blob/main/tmpfiles.d/systemd.conf.in (line 61) |
| 5.16 | `/var/log/journal/<machine-id>/user-<UID>.journal` | systemd-journald | n/a: "owned and readable by the 'systemd-journal' system group but are not writable"; the user gets read via ACL only. | Out of scope (root). There is no per-user journal the user can delete. | https://man.archlinux.org/man/systemd-journald.service.8 |

## 6. Temp folders, and the allowed-root rule

| # | Path | Written by | When removed | Group | Source |
|---|---|---|---|---|---|
| 6.1 | `/tmp/*` entries owned by the user | Any program. systemd ships `q /tmp 1777 root root 10d`. | Recreated on demand; a running process may still use one. UAPI: "usually mounted as a tmpfs". | Review first: same as macOS `/private/tmp`. Moving a tmpfs entry to the home Trash fails with `EXDEV`, and the per-volume `/tmp/.Trash-$uid` keeps it in RAM and loses it at reboot (owner decision, section 9). | https://uapi-group.org/specifications/specs/linux_file_system_hierarchy/ ; https://github.com/systemd/systemd/blob/main/tmpfiles.d/tmp.conf ; https://man7.org/linux/man-pages/man2/rename.2.html |
| 6.2 | `/var/tmp/*` entries owned by the user | Programs needing "larger and persistent temporary files"; systemd ages them after 30 days. | Same as 6.1, but persistent across reboot. | Review first: new to the allowed roots. | https://uapi-group.org/specifications/specs/linux_file_system_hierarchy/ ; https://github.com/systemd/systemd/blob/main/tmpfiles.d/tmp.conf |
| 6.3 | `$XDG_RUNTIME_DIR` | see 1.5 | see 1.5 | Never | see 1.5 |
| 6.4 | `$TMPDIR` | Usually unset on Linux; tools fall back to `/tmp` (uv documents exactly that order). | n/a | Not a separate root. If set inside `$HOME` it is already covered; if set elsewhere, owner decision. macOS's per-user `$TMPDIR/../{T,C,X}` tree has no Linux counterpart, so `user-tmpdir` and `code-sign-clones` are dropped. | https://docs.astral.sh/uv/reference/storage/ |

**Translation of the macOS allowed-root rule.** macOS `in_allowed_root` allows inside `$HOME`, inside
`/private/tmp`, and inside the per-user `$TMPDIR/{T,C,X}`; everything else is blocked. Proposed for Linux:
inside `$HOME`, or a direct child of `/tmp` or `/var/tmp` whose owner is the running uid (the scan
already filters by `uid` for `/private/tmp`). Optionally, per-volume trash folders `$topdir/.Trash/$uid`
and `$topdir/.Trash-$uid` (row 5.2). Everything else is blocked. The Linux `SYSTEM` list (a backstop only,
since outside-`$HOME` paths are already refused) would be `/usr /bin /sbin /lib /lib64 /etc /var /opt /boot
/root /srv /snap /proc /sys /dev /run /nix`, with `/var/tmp` excepted.

## 7. Protected folders (Never)

The macOS `PERSONAL` list is matched case-insensitively under `$HOME`. Linux file systems are
case-sensitive; keeping the case-insensitive match only blocks more, never less.

| # | Path | Why protected | Source |
|---|---|---|---|
| 7.1 | `$HOME` and every ancestor | Same as macOS. | `clean.rs` `is_protected` |
| 7.2 | XDG user dirs DESKTOP, DOCUMENTS, PICTURES, MUSIC, VIDEOS (the macOS `Movies`), TEMPLATES, PUBLICSHARE, read from `$XDG_CONFIG_HOME/user-dirs.dirs`, **plus** the English defaults `Desktop Documents Pictures Music Videos Templates Public` | Personal files. The names are localized: `xdg-user-dirs-update` writes `user-dirs.dirs` and records the translation locale in `user-dirs.locale`. A German home has `~/Bilder`, not `~/Pictures`, so a fixed English list misses it. | https://man.archlinux.org/man/user-dirs.dirs.5 ; https://man.archlinux.org/man/xdg-user-dirs-update.1 |
| 7.3 | XDG DOWNLOAD dir | Not Never: handled as on macOS, where `Downloads` is not blocked but old entries are Report only (`scan_old_downloads`). Use the resolved, possibly localized path. | https://man.archlinux.org/man/user-dirs.dirs.5 |
| 7.4 | `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.claude` | Same as macOS `PERSONAL`. | `clean.rs` `PERSONAL` |
| 7.5 | `~/.config/gh` (`GH_CONFIG_DIR`) | GitHub CLI configuration and stored credentials. | https://cli.github.com/manual/gh_help_environment |
| 7.6 | `~/.config/gcloud` (`CLOUDSDK_CONFIG`) | gcloud configuration and credentials. | https://docs.cloud.google.com/sdk/docs/configurations |
| 7.7 | `$XDG_DATA_HOME/keyrings`, legacy `~/.gnome2/keyrings` | GNOME Keyring secret store (the macOS Keychains). | https://gitlab.gnome.org/GNOME/gnome-keyring/-/blob/main/pkcs11/gkm/gkm-util.c (`gkm_util_locate_keyrings_directory`) |
| 7.8 | `$XDG_DATA_HOME/kwalletd` | KDE Wallet secret store. | No primary source found. |
| 7.9 | `~/.password-store` (`PASSWORD_STORE_DIR`) | pass: "All passwords live in `~/.password-store`". | https://www.passwordstore.org/ |
| 7.10 | `~/.pki` | NSS certificate and key database used by Chromium on Linux. | No primary source found. |
| 7.11 | Browser profiles: `~/.config/google-chrome`, `~/.config/chromium`, `~/.mozilla`, Firefox 147+ XDG profile folders, `~/.var/app/*/.mozilla` and other Flatpak/Snap app data (rows 5.4, 5.7) | Bookmarks, passwords, cookies and logins. | https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md ; https://bugzilla.mozilla.org/show_bug.cgi?id=259356 |
| 7.12 | `~/.thunderbird` | Thunderbird profile: "mail messages, passwords" (the macOS `Library/Mail`). | https://wiki.mozilla.org/Thunderbird/Support/profile |
| 7.13 | `$XDG_DATA_HOME/evolution`, `~/Maildir`, `~/mail` | Other local mail stores. | No primary source found. |
| 7.14 | `~/.docker` except the report-only row 5.12 | `config.json` registry credentials. | No primary source verified (not fetched). |
| 7.15 | `~/.cache/disk-clean`, `$HF_HOME/token`, `~/.android` (rows 2.1, 2.2, 4.7) | See those rows. | See those rows. |

## 8. Fixed commands (candidates, owner decision for each)

macOS runs exactly three by fixed id. The spec says "No new command is added without the user
naming it", so every row below is a candidate only.

| Id | Command | What it removes | Root? | Undo | Notes |
|---|---|---|---|---|---|
| docker-prune | `docker system prune -f` | "all stopped containers, all networks not used by at least one container, all dangling images, unused build cache"; never volumes without `--volumes`. | Rootless Docker: no. Rootful Docker: the user only needs the `docker` group, but Docker says that group "grants root-level privileges" and the daemon "always runs as the root user", so the command deletes root-owned files under `/var/lib/docker`. That breaks the "never touches anything the user does not own" promise; owner decision (offer only for rootless and Docker Desktop contexts?). Docker Desktop for Linux: frees space inside the VM disk, as on macOS (`≈`). | No | https://docs.docker.com/reference/cli/docker/system/prune/ ; https://docs.docker.com/engine/install/linux-postinstall/ |
| podman-prune | `podman system prune -f` | "all unused containers …, build containers, pods, networks", "all dangling images", "all dangling build cache"; volumes only with `--volumes`. | No (rootless). | No | New command; owner must name it. https://docs.podman.io/en/latest/markdown/podman-system-prune.1.html |
| flatpak-unused | `flatpak uninstall --unused --user --noninteractive` | Runtimes and extensions in the per-user installation no app uses any more; app data in `~/.var/app` is kept. | No, with `--user`. | No; reinstall with `flatpak install`. | New command; owner must name it. https://man.archlinux.org/man/flatpak-uninstall.1 |
| brew-cleanup | `brew cleanup --prune=all -s` | Outdated downloads and "old versions of installed formulae"; `--prune=all` removes all cache files, `-s` scrubs even latest-version downloads. | No, when the user owns the prefix (Homebrew on Linux: "The managing account needs write access to the installation"). | No | Same id as macOS. https://docs.brew.sh/Manpage ; https://docs.brew.sh/Homebrew-on-Linux |
| go-modcache | `go clean -modcache` | The whole module cache. | No | No | Only if the Trash path for row 3.17 is dropped; it exists because the cache is read-only on purpose. New; owner must name it. https://pkg.go.dev/cmd/go |
| xcode-unavailable-sims | n/a | n/a | n/a | n/a | macOS only. |

## 9. Out of scope (need root)

| What | Path | Source |
|---|---|---|
| apt / dnf / pacman package caches | `/var/cache/apt`, `/var/cache/dnf` (or `yum`), `/var/cache/pacman/pkg` | FHS `/var/cache`: https://refspecs.linuxfoundation.org/FHS_3.0/fhs/ch05s05.html (exact per-distro paths: no primary source fetched) |
| `/var/cache` in general | `/var/cache` | https://refspecs.linuxfoundation.org/FHS_3.0/fhs/ch05s05.html |
| System journal, per-user journals included | `/var/log/journal` | https://man.archlinux.org/man/systemd-journald.service.8 |
| systemd-coredump | `/var/lib/systemd/coredump` | https://man.archlinux.org/man/systemd-coredump.8 |
| System Flatpak installation | `/var/lib/flatpak` | No primary source fetched for the path; `flatpak uninstall` without `--user` acts on it. |
| Snap revisions, snapshots, snapd data | `/var/lib/snapd`, `/snap` | https://snapcraft.io/docs/reference/administration/data-locations/ (snapshots kept 30 days after removal) |
| Old kernels | `/boot`, `/lib/modules`, `/usr/lib/modules` | No primary source fetched. |
| Rootful Docker data root | `/var/lib/docker` | https://docs.docker.com/engine/install/linux-postinstall/ (daemon runs as root); see the docker-prune caveat in section 8. |
| Ubuntu apport crash reports | `/var/crash` | No primary source fetched. |

## 10. Differences from macOS that affect classification

1. **`~/.cache` is a convention, not a guarantee.** On macOS the tool offers every child of
   `~/Library/Caches`. On Linux the same folder also holds a login token (Hugging Face, row 2.2), live
   virtualenvs (Poetry, row 2.7), IDE Local History (JetBrains, row 2.9), multi-GB model stores
   (rows 2.3, 2.6), and disk-clean's own Trash record (row 2.1). Row 1.1 is only safe with an explicit
   exception list, and the list will need to grow. Sources: basedir spec; the rows cited.
2. **Many tools ignore XDG**, so their caches are dot-folders in `$HOME`: npm (`~/.npm`), Bun (`~/.bun`),
   Cargo (`~/.cargo`), Go modules (`~/go`), Gradle (`~/.gradle`), Maven (`~/.m2`), Yarn berry
   (`~/.yarn/berry`), Puppeteer (hard-coded `~/.cache/puppeteer`, even when `XDG_CACHE_HOME` is set).
   Others follow XDG only sometimes: RubyGems (`~/.gem` if it exists, else XDG), Composer (XDG "on
   systems adhering to XDG", else `~/.composer`), nvm (`$XDG_CONFIG_HOME/nvm` when set, a toolchain under
   `~/.config`). The table has to resolve each path the way the tool does, not with one rule.
3. **Hard-link stores.** pnpm's default import on Linux "tries hardlinking before cloning" (cloning first
   on macOS), and Bun "defaults to using hardlinks" on Linux. So store files and `node_modules` files are
   often the same inode. The walk counts a hard-linked file once, under whichever path it reaches first,
   so the size shown for the pnpm store, the Bun cache or a `node_modules` row can over- or under-state
   what deleting that row frees. These rows should be measured as "blocks only this path holds" (nlink-aware),
   or marked `estimate` as pnpm `node_modules` already is on macOS. The macOS note "Breaks every existing
   node_modules … until each project reinstalls" may not hold on Linux, where hard links keep the files
   alive (inference; not tested).
4. **Per-volume Trash and tmpfs.** The freedesktop Trash spec puts items from another volume into
   `$topdir/.Trash-$uid`, and `rename()` across mounts fails with `EXDEV`. `/tmp` is usually tmpfs,
   so trashing a `/tmp` entry frees no RAM and the item disappears at reboot. A separate `/home`
   partition likewise means `/var/tmp` items land in `/var/tmp`'s volume trash, if that volume
   allows one.
5. **Read-only trees.** The Go module cache is read-only on purpose, and `rename(2)` of a directory needs
   write permission on that directory "to update the .. entry". Moving the top folder works only when
   that folder itself is writable; Empty and Delete immediately must `chmod u+w` recursively first.
   Bazel output trees behave similarly (inference).
6. **Files the user cannot touch inside `$HOME`.** Rootless Docker and Podman store files under
   subordinate UIDs (`/etc/subuid`), so a plain move fails even though the folder is in `$HOME`. They
   can only be reclaimed through their own commands.
7. **No Logs folder.** macOS has `~/Library/Logs`; Linux puts logs in `$XDG_STATE_HOME` beside state
   (spec), inside caches (JetBrains `…/log`), or in the journal (not user-deletable). The Linux "Logs
   and crash reports" section has almost nothing to list: only user-owned `core` files (row 5.14).
8. **Electron and Chromium cache placement differs.** Chrome itself puts its disk cache under
   `$XDG_CACHE_HOME`, but Electron apps keep theirs in `sessionData`, which defaults to
   `$XDG_CONFIG_HOME/<App>`, next to cookies (rows 4.1, 4.2).
9. **Sandboxed app trees.** Flatpak sets each app's `XDG_CACHE_HOME` to `~/.var/app/<id>/cache`, and snapd
   rewrites `HOME` to `~/snap/<name>/<rev>`, so the cache/data split repeats once per app. Both keep user
   data after the app is uninstalled (Flatpak without `--delete-data`), and snap keeps per-revision data
   copies.
10. **Localized personal folders.** The macOS `PERSONAL` names are fixed English names. On Linux they come
    from `user-dirs.dirs` and are translated, so the protected list must be read at run time (row 7.2).
11. **Distributions and versions differ.** Steam lives at `~/.local/share/Steam` or
    `~/.steam/debian-installation`; Firefox moved to XDG folders in 147 for new profiles only; RubyGems,
    Composer and nvm switch layout depending on what already exists. A fixed path table will be wrong
    on some machines; probing (`brew --cache`, `go env GOMODCACHE`, `pnpm store path`) is more reliable
    where a tool offers one. macOS already does this for Homebrew (`probe_brew`).
12. **The `docker` group is root.** On macOS the Docker VM disk belongs to the user. On Linux with rootful
    Docker, `docker system prune` removes root-owned files without sudo (section 8).

## 11. Open points for the owner

1. Is the "Not listed" label wanted, or should everything outside the offered rows be hard-blocked
   (stricter, but then `~/.local/share` cannot be blocked as a whole)?
2. Should row 1.1 offer every child of `~/.cache` (as macOS offers every child of `~/Library/Caches`) with
   a denylist (section 2), or only an allowlist of known caches?
3. `/tmp` items on tmpfs: Trash (keeps RAM, gone at reboot), Delete immediately only, or not offered?
4. Per-volume trash folders as an allowed root (row 5.2)?
5. Docker prune on rootful Docker (section 8).
6. New rows with no macOS counterpart: 3.2, 3.14, 3.20, 4.1, 4.2, 4.6, 5.5, 5.8, 5.14, and the new
   commands in section 8.

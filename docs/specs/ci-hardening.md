# CI and release hardening

Status: approved for building 2026-10-05 (the user: "fix all the issues you find, make sure to be extra triple
careful"). Source: a read-only CI/supply-chain review of the `windows` branch at ca7d2ad by Fable, and the partial
log of an Astra (gpt-6-astra) review of the same commit that stopped at the account's usage limit. Every finding
below was checked against the code or the upstream source before it was written here.

Lands on `linux-release` (PR #9) first, then merges into `windows`, which applies the same rules to its Windows jobs.

## 1. Socket Firewall binary is pinned and checked

Finding: `SocketDev/action@ba6de6cc` pins the action's JavaScript, not the `sfw` binary it installs.
`firewall-version` defaults to `latest` (action.yml line 32-34 at that SHA), resolved at run time through the
GitHub API, downloaded from `SocketDev/sfw-free` and executed with no checksum or signature check
(`src/tools/firewall.js`). In `release.yml` that binary runs in the workspace before `cargo build`, so a compromised
sfw-free release could change the source the release is built from, and the result would be checksummed and
attested as ours.

Rule:
- No job uses `SocketDev/action`. Each job that fetched through it installs sfw itself in one step: download
  `https://github.com/SocketDev/sfw-free/releases/download/v1.15.4/sfw-free-<platform>` with
  `curl --proto '=https' --tlsv1.2 -fsSL`, check it against the SHA-256 written in the workflow for that platform,
  refuse to continue on a mismatch, then put it on `PATH` and set `SFW_JSON_REPORT_PATH` to a file under
  `$RUNNER_TEMP` (what the action did). The existing "Socket Firewall report" step stays as it is.
- Digests (from the v1.15.4 release's asset digests, read 2026-10-05 through the GitHub API):
  - `sfw-free-linux-x86_64` `cf9f55b8343e1ef6e6dcccdb09b99c70c0430a22ed7d0079286eccddeaf72670`
  - `sfw-free-linux-arm64` `c8c80aa582829f24f5d633f2c3f2ccd0b070bbee80bf3b956e5e2a9880184e20`
  - `sfw-free-macos-arm64` `1b705ea7c399727ee41aa93f63e0469d2c3787c50e1dd8842cb8ff5ceec9eb99`
  - `sfw-free-macos-x86_64` `b19f96f0dd3ebc4ecc7111dbc43cc2b095f37bf759273c0bd9c0c4784ea24731`
  - `sfw-free-windows-x86_64.exe` `f8c94fc5e41d49c51d2fd013c2c169274df9c483fc763d8c82ff71c5579d3bb0`
  - `sfw-free-windows-arm64.exe` `16607f9c64055b8e0af918dc93a72a342ca8352f46e6e3f810d1a378a380a82a`
- Because sfw-free ships a Windows arm64 build, the Windows arm64 jobs (CI and release) fetch through sfw like every
  other job; their "lockfile-pinned, no firewall" exception and its `needs` on the x86_64 job go away (the `needs`
  stays only if it is still wanted for ordering; say which).
- `SocketDev/action` leaves the allowed-actions list only when the user changes the repo setting; the workflows
  simply stop using it. Dependabot no longer bumps sfw: the version and digests are bumped by hand, with the digests
  read from the release's asset list.
- Before building, the implementer confirms that `SFW_JSON_REPORT_PATH` is what makes sfw write its report (read
  sfw's `--help` or the sfw-free README); if sfw needs a flag instead, use the flag and say so.

## 2. Launcher downloads use HTTPS only

Finding: `run.sh` runs `curl -fsL` (lines 50-51), which follows a redirect to any scheme.
Rule: `curl --proto '=https' --tlsv1.2 -fsL --retry 2` for both the archive and its `.sha256`. `run.ps1` already
forces TLS 1.2 against an `https` URL; unchanged.

## 3. Tests never point a real delete at a real system file

Finding: the end-to-end clean tests put a real system file into the scan and the selection (`/etc/hosts` in
`tests/clean.rs` lines 546, 556, 689; `C:/Windows/System32/drivers/etc/hosts` through `SYSTEM_FILE` in the Windows
twin), run the real `clean`, and only afterwards assert the file still exists. The protected-path rule under test is
the only thing between a regression and the machine's hosts file; the Windows suite runs as administrator.
Rule: those end-to-end tests use a protected path inside the sandbox home on the test volume (for example
`<home>/.ssh/id_rsa`, which `bin(home)` makes protected by pointing `HOME`/`USERPROFILE` there) and assert the same
"rejected (protected path)" outcome. Real system paths stay only in the string-only table tests
(`is_allowed_table*`, and `review::preview` uses that never touch the file system). `SYSTEM_FILE` is deleted if
nothing else needs it.

## 4. pnpm is pinned by hash

Finding: `package.json` `"packageManager": "pnpm@10.33.4"` has no hash, so Corepack fetches pnpm by version only
(Corepack README: "The hash is optional but strongly recommended as a security practice").
Rule: `"packageManager": "pnpm@10.33.4+sha512.<hash>"`, the hash taken from the npm registry's `dist.integrity` for
pnpm 10.33.4 (or written by `corepack use pnpm@10.33.4`). CI's `corepack enable` then refuses a different tarball.

## Repository settings (the owner's to change; not code)

- Immutable releases: release assets cannot be modified or deleted and tags cannot be moved once published. Closes
  the asset-swap case in which both the archive and its `.sha256` are replaced on the same release (the launchers
  check only that the two match).
- A tag ruleset restricting creation of `disk-clean--v*` tags to the owner, so no other writer can cut a release.

## Considered and not changed

- Pinning release checksums inside the plugin (so the launcher would not trust the `.sha256` beside the archive):
  needs a release flow that commits checksums after the build. Immutable releases cover the realistic case, a swap
  after publishing, without that.
- `brew install shellcheck` (only when the runner lacks it) and `playwright install` (browsers by version from
  Microsoft's CDN) run only in PR CI, which has a read-only token and no secrets.
- `--generate-notes` copies merged PR titles into release notes: reviewed at merge time.
- The `windows` crate pulls ten Microsoft crates and a second `syn` (all crates.io, all with checksums in
  `Cargo.lock`); the earlier claim that only two crates were added was wrong.

## Checks

- actionlint and zizmor clean; `grep -rn "SocketDev/action\|firewall-version" .github` empty.
- macOS, Linux (Docker) and, on `windows`, the Windows type-check green as before; the changed tests pass.
- The new install step's checksum check is shown to fail: run the step's shell with one digest altered (locally,
  against the real download) and paste the refusal.

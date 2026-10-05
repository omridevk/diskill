# disk-clean: Linux and native Windows

Status: step 1 is ready-for-agent once the order against one-session.md is settled; steps 2 and 3
each start with the location list in the open questions. Draft written 2026-10-05
from a conversation in another session (the user: "I want to make this work in Windows and Linux";
"native windows is ideal no?"; the order below got "sounds good"). Checked against ui-v2 at 2236464.

## Problem Statement

disk-clean only runs on macOS. A user on Linux or Windows who installs the plugin gets a launcher
that downloads a macOS binary, or a source build that does not compile: the disk walk, the Trash,
the volume totals, the list of places worth cleaning, the protected folders and the process checks
are all written against macOS calls and macOS paths. The crate has no platform split at all today.

A Windows user's reclaimable space is on the Windows side (app caches, temp folders, `node_modules`
on the system drive, the Recycle Bin), so running the Linux build inside WSL would not help them.

## Solution

The same plugin, the same review page and the same safety promises on macOS, Linux and native
Windows:

- `/disk-clean` scans the user's disk, opens the same review page, and nothing is deleted without an
  approval in that page.
- Delete moves approved items to the platform's own trash, the way the platform's file manager does
  it, so the file manager can restore them too: the macOS Trash, the freedesktop.org Trash on Linux,
  the Recycle Bin on Windows. Undo and Empty in the page work on all three.
- The cleanup list shows what is worth cleaning on that platform, with the same Safe / Review first /
  Report only grouping.
- The launcher fetches the binary built for the user's platform and architecture, checksum-verified.

The work lands in three steps, each shippable on its own:

1. Put a platform boundary into the macOS code with no behaviour change.
2. Linux.
3. Native Windows.

Linux comes before Windows because it shares the POSIX path model, so it forces the boundary to be
right while the safety rules can still be reused. Windows then only has Windows problems to solve.

## User Stories

1. As a Linux user, I want `/disk-clean` to scan my home folder and open the review page, so that I
   can see what is eating my disk.
2. As a Windows user, I want `/disk-clean` to scan my Windows drive natively, so that I see the space
   Windows apps and tools use, not a Linux subsystem's view.
3. As a user on any platform, I want the same review page with the same tabs, filters, shortcuts and
   addresses, so that what I learned on one machine applies on another.
4. As a Linux user, I want the cleanup list to know Linux locations (the XDG cache folder, package
   manager caches, per-user logs), so that the recommended selection is useful without my editing it.
5. As a Windows user, I want the cleanup list to know Windows locations (per-user app caches, the
   temp folder, package manager caches under my profile), so that the recommended selection is
   useful without my editing it.
6. As a developer on any platform, I want `node_modules`, stale build output and the cross-platform
   package manager caches (npm, pnpm, yarn, bun, pip, uv, cargo, go) found wherever that platform
   keeps them, so that the developer sections work everywhere.
7. As a developer on any platform, I want git worktrees listed and offered for removal under exactly
   the same conditions as on macOS, so that a worktree with unsaved work is never offered.
8. As a Linux user, I want Delete to move items to my desktop's Trash, so that my file manager shows
   them and can restore them.
9. As a Windows user, I want Delete to move items to the Recycle Bin, so that Explorer shows them and
   Restore works.
10. As a user on any platform, I want Undo in the page to put every item of a cleanup back exactly
    where it was, so that a mistake costs nothing.
11. As a user on any platform, I want Undo to refuse to overwrite something that now exists at the
    original path, so that a reinstalled folder is never clobbered.
12. As a user on any platform, I want Empty to delete only the items disk-clean put in the trash, so
    that my other trashed files are never touched.
13. As a user on any platform, I want the Trash tab to stay in sync when I restore or empty items in
    my file manager, so that the page never claims something it no longer controls.
14. As a user on any platform, I want Delete immediately to skip the trash and say "can't be
    undone", so that I can free space right away when I mean it.
15. As a Windows user, I want an item that is open in another program to be kept and reported as in
    use, so that a failed move is explained instead of silently skipped.
16. As a Linux user with files on another mounted volume, I want an item the Trash cannot take to be
    kept and reported with the reason, so that nothing is deleted for good behind my back.
17. As a user on any platform, I want my documents, pictures, keys, credentials and mail to be
    blocked regardless of what was selected, so that no selection can ever reach them.
18. As a Windows user, I want protected folders matched without regard to letter case and across
    drive letters, so that a differently-cased path cannot slip past the block list.
19. As a user on any platform, I want links to be moved or removed themselves and never followed
    (symlinks, and on Windows junctions and other reparse points), so that a cleanup can never leave
    the folder I approved.
20. As a user on any platform, I want every path resolved again right before it is moved, so that a
    folder swapped for a link after the scan is kept.
21. As a Windows user with cloud-synced folders, I want the scan to size online-only files without
    downloading them, so that scanning never fills my disk or my bandwidth.
22. As a user on any platform, I want sizes to mean space actually allocated, with hard-linked files
    counted once, so that the reclaimable figure matches what I get back.
23. As a user on any platform, I want the Storage tab to reconcile the whole disk in my platform's
    terms, so that I can see the space this tool cannot reclaim.
24. As a Linux or Windows user, I want Docker space reported with the same caveats as on macOS, so
    that I am not promised space the platform will not return.
25. As a user on any platform, I want no command to ask for administrator or root rights, so that
    the tool can never touch system-owned files.
26. As a Windows user, I want system-level caches that need administrator rights left out, so that
    the list only shows what the tool can actually clean.
27. As a user on any platform, I want the launcher to download the binary for my platform and
    architecture and verify its checksum, so that the first run just works and is trustworthy.
28. As a user without a published binary for my platform, I want the launcher to build from source
    when Rust is installed, or tell me plainly what is missing, so that I am never left with a
    cryptic error.
29. As a user on any platform, I want the review page to open in my default browser, so that I do
    not have to copy an address.
30. As a user on any platform, I want only one cleanup to run per run at a time, so that two
    approvals can never race over the same files.
31. As a macOS user, I want nothing about my experience to change when the platform boundary lands,
    so that the port costs me nothing.
32. As a maintainer, I want everything that differs by platform to live behind one boundary, so
    that scan, review, validation and the page server contain no platform conditionals.
33. As a maintainer, I want the full safety test suite to run on a real machine of each platform in
    CI, so that a delete path is never shipped on the strength of a cross-compile.
34. As a maintainer, I want the tests on every platform to run on an isolated throwaway volume and
    never against the real home folder, so that a test bug cannot delete my files.
35. As a maintainer, I want each platform's release asset attested and checksummed the way the macOS
    one is today, so that the supply-chain guarantees do not weaken with more platforms.
36. As Claude running the skill, I want the same commands, exit codes, run directory files and log
    lines on every platform, so that one SKILL.md serves all three.

## Implementation Decisions

- **Three steps, in this order:** platform boundary on macOS with no behaviour change, then Linux,
  then native Windows. Each step ends with every existing test green on macOS.
- **One platform boundary.** A single platform module with one implementation per operating system,
  chosen at compile time. Everything outside it is platform-neutral. Behind it:
  - the disk walk (entries with name, kind, allocated size, link count, file identity, modified
    time, and whether a directory is a mount point);
  - the trash (move to trash returning where the item landed, restore without overwriting, remove
    one of our items from the trash, check that a recorded item is still the same file in a trash);
  - volume totals and the whole-disk reconciliation figures;
  - the table of locations worth cleaning and how each is classified;
  - the protected-path list and the path comparison rule;
  - the working directories (or equivalent) of the user's running processes, for the worktree check;
  - the fixed commands that may run, by id;
  - small process facilities: opening a URL in the default browser, random token bytes, starting a
    detached worker, the run lock, lowering scan priority, core count, local time formatting.
- **Platform-neutral and unchanged:** the review page, the page server and its event stream, the
  selection and validation code, the scan record and run directory formats, the Trash record format,
  exit codes, log lines, the git worktree conditions, `node_modules` and build-output detection.
- **Trash per platform, always the system's own mechanism:**
  - macOS: as today.
  - Linux: the freedesktop.org Trash specification (home trash, per-volume trash folders,
    `.trashinfo` records), so file managers show and restore our items.
  - Windows: the Recycle Bin through the shell's file-operation interface, the one Explorer uses, so
    Explorer's Restore works. Our own Undo never depends on the file manager's restore, as today.
- **The Trash record keeps its meaning** on every platform: written before the move, completed
  after, synced on every command and page load, and anything ambiguous is marked failed and never
  acted on. File identity is whatever the platform offers as a stable identity for "the same file".
- **Safety rules are restated per platform, not adapted by search and replace.** On Windows that
  means case-insensitive comparison, drive letters and network paths, long paths, and treating
  junctions and all reparse points as links that are never followed. The rule "only paths the scan
  showed, canonical, allowed, re-resolved right before the move" is identical everywhere.
- **Cloud placeholders are never hydrated** by the walk on Windows; they are sized by what is on
  disk.
- **Items in use on Windows** get their own reported outcome (kept, in use), shown in the page log
  like any other kept item.
- **No administrator or root rights, ever**, on any platform. Locations that need them are out of
  the tables.
- **Fixed commands are per platform.** The macOS-only ones (simulators, Homebrew) exist only there;
  Docker prune exists wherever Docker is found. No new command is added without the user naming it.
- **Launcher and releases:** one release asset per platform and architecture, each with a checksum
  and attestation like today's. The launcher picks the asset for the machine it runs on and keeps
  the source-build fallback.
- **SKILL.md stays one document**, with platform differences stated where they exist (trash name,
  what the scan covers, protected folders).

## Testing Decisions

- A good test here drives the built binary the way Claude and the page do (commands, the page's
  HTTP requests, files in the run directory, what is and is not on disk afterwards) inside a
  sandboxed home on a throwaway volume. It asserts outcomes a user could observe, never internal
  functions of a platform implementation.
- **One seam, the existing one:** the compiled binary run with its home folder pointed at a sandbox,
  as the Rust integration tests do today. No new seam is added for the port. The platform boundary
  is not mocked; each platform's implementation is exercised through the binary on that platform.
- **The only new test facility is the throwaway volume per platform** (today a macOS RAM disk). The
  guard that fails any test touching a path outside that volume stays and applies everywhere.
- **Step 1 (boundary):** the existing suite, unchanged, is the test. No test may need editing for
  the refactor to pass; an edit means behaviour changed.
- **Steps 2 and 3:** the existing safety, clean, trash, scan, worktree, selection and review suites
  run on that platform. Platform-specific cases are added beside them:
  - Linux: trash on the home volume and on another volume, `.trashinfo` written and honoured,
    restore refusing to overwrite, an item restored or emptied in the file manager's way being
    picked up by sync.
  - Windows: Recycle Bin round trip, an item in use kept and reported, a junction moved itself and
    not followed, case-different spellings of a protected path rejected, a long path handled, an
    online-only placeholder sized without download.
- **Browser tests** of the page stay as they are; the page does not change by platform. They keep
  running in Chromium and Firefox.
- **CI runs the Rust suite on a real runner of each platform.** A platform is not released until its
  runner is green.
- Prior art: the existing Rust integration tests and their shared sandbox helpers, and the Trash
  tests in particular for record and sync behaviour.

## Out of Scope

- WSL as the Windows answer. The Linux build may happen to run there; it is not the Windows port.
- Anything needing administrator or root rights: system package caches owned by root, Windows
  Update and component store cleanup, system temp folders.
- BSDs and other Unix systems.
- A native installer or package (deb, rpm, winget, Homebrew). Distribution stays the plugin launcher.
- New features. The one-session change (one-session.md) is separate and unaffected by this spec,
  apart from landing order.
- Changes to the review page's design or behaviour.

## Further Notes

Answered by the user on 2026-10-05:

- **New crate for Windows: yes, if it is a good one.** The Recycle Bin interface is a COM interface,
  so the crate is Microsoft's own `windows` crate (the windows-rs project). Its sibling
  `windows-sys` is not enough: it carries functions and structs only, no COM interfaces. Limit the
  enabled features to the shell and COM pieces the Trash needs.
- **Linux without a desktop: use the Trash folders anyway** ("probably trash"). Undo keeps working
  and behaviour is the same on every machine.
- **Architectures: x86_64 and arm64 for both Linux and Windows.**

Still open, the user's to answer:

1. **Which locations are listed, and which are preselected as Safe, on Linux and on Windows.** Not
   known yet ("we need to figure this out"). This is the first task of each platform step, before
   any scan code for that platform: a list per platform with, for every location, what writes it,
   what breaks or has to be re-downloaded when it is removed, and the proposed group (Safe / Review
   first / Report only), each line with its source. The user reviews the list before anything ships
   preselected.
2. **Order against one-session.md.** Step 1 (the boundary) touches the same files as the
   one-session work. Which lands first?

Facts checked, not questions:

- **Launcher on Windows.** Claude Code's setup documentation (read 2026-10-05) says Git for Windows
  is optional on native Windows: with it the Bash tool runs in Git Bash, without it Claude Code
  runs shell commands through its PowerShell tool. So a bash-only launcher does not reach every
  native Windows user; Windows needs a PowerShell launcher beside the shell one, and SKILL.md has
  to give the command for each.
- **Throwaway test volume.** Mounting one needs elevated rights on Linux and Windows. GitHub-hosted
  runners give passwordless sudo on Linux and an administrator account on Windows, so CI can do it.
  The product itself still never asks for those rights.

Size of the port, measured on ui-v2: about 7,000 lines of Rust, of which the walk (about 950 lines)
and the Trash (about 1,000 lines) are macOS-specific end to end, and about 5,700 lines of tests
written against macOS semantics.

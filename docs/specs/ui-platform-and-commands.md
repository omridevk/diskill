# Review page: platform-aware text, command palette, shortcut cheatsheet

Status: draft 2026-10-05, from the user's requests in conversation ("we need to fix all the UI to be
aware of the platform"; "we also must add a cmdk menu ... so it will be dynamic so we can add more
actions"; "a '?' hotkey to show a dialog with all the cheatsheet"; Linux Delete-immediately keys: "yes").
Branch `ui-commands`, stacked on `linux` (PR #6). Builds on `linux.md` and `cross-platform.md`.
Inventory of today's actions, routes and hotkeys: research done 2026-10-05 against
`plugins/disk-clean/web` at c1dce83 (file:line references below are from it).

## 1. The page knows its platform

- The server tells the page: a `<meta name="disk-clean-platform" content="macos|linux">`, filled like
  the existing token/home metas (`review.rs` `render`, and the helper's approved page in `watch.rs`),
  from a per-platform constant in `src/platform/{macos,linux}`. `lib/data.ts` `load()` reads it into
  `Loaded`. Dev fixtures default to `macos`; a fixture/query switch gives `linux` for tests.
- One web module holds every platform-dependent string (`lib/platform.ts` or similar): Trash name,
  manual-restore wording, the Trash-tab "put back" label, the Storage reconciliation rows and notes.
  Components read from it; no `platform === ...` checks scattered in components.
- The macOS page renders byte-identical text to today. Linux wording:

| Where | macOS (unchanged) | Linux |
|---|---|---|
| About deleting (`action-bar.tsx:89`) | "…moves files to the macOS Trash. Undo puts them back; Finder's Put Back works too…" | "…moves files to the Trash. Undo puts them back; your file manager's Restore works too…" |
| Empty dialog (`empty-dialog.tsx:31`) | "Undo and Finder's Put Back stop working for them." | "Undo and your file manager's Restore stop working for them." |
| Trash state `put-back` (`trash-view.tsx:34`) | "Put back in Finder" | "Restored in the file manager" |
| Storage row 2 hint (`storage.tsx:167`) | "/Applications, other users, /usr/local, system-wide caches" | "/usr, /var, other users, system-wide caches" |
| Storage row 3 (`storage.tsx:167`) | "macOS system volume and APFS reserve" / "sealed system, Preboot, Recovery, swap and snapshots; not user-deletable" | "System and reserved space" / "blocks the filesystem keeps for itself and for root; not user-deletable" |
| Storage overcount note (`storage.tsx:175`) | "…APFS clones and snapshots share blocks." | "…hard links and reflinked copies share blocks." |
| Snapshots note (`storage.tsx:191`) | Time Machine text | not shown (Linux reports 0 snapshots) |

## 2. Shortcuts per platform

- Shortcut labels are never hard-coded: they come from `formatForDisplay` of `@tanstack/hotkeys`
  (already installed) with the server's platform, so macOS shows `⌘⌫` and Linux `Ctrl+⌫`. The macOS
  labels stay exactly as today.
- Delete: `Mod+Backspace` on both (Cmd on macOS, Ctrl on Linux), plus Backspace/Delete inside the item
  table, unchanged.
- Delete immediately: macOS unchanged (`Mod+Alt+Backspace`, `Shift+Backspace`). Linux:
  `Shift+Backspace` and `Shift+Delete`; `Ctrl+Alt+Backspace` is NOT registered on Linux (on some X11
  setups it kills the graphical session).

## 3. One action list feeds hotkeys, the palette and the cheatsheet

- A small registry: components declare their actions with one hook (for example
  `useCommands([...])`), each `{id, name, group, keywords?, hotkey?, enabled, run}`. The hook
  registers the hotkeys through `useHotkeys` with `meta: {name, group}` (TanStack Hotkeys' own
  metadata) and adds the actions to a shared list the palette reads. Actions appear and disappear
  with the component that owns them, so the palette is always in context (Trash actions only on the
  Trash tab, Undo only after a cleanup). Adding an action is one entry in the owning component.
- The existing hotkeys (`cleanup.tsx:547-551`, `action-bar.tsx:137-160`) move into this hook with
  their current guards (`ignoreInputs`, the dialog/overlay checks), behaviour unchanged.
- No action in the palette or a hotkey ever commits a destructive step. Delete, Delete immediately and
  Empty open their existing confirm dialogs; the confirm buttons are not palette actions.

## 4. Command palette

- shadcn's `command` component (built on `cmdk`), added with the shadcn CLI for this project's
  `base-nova` style so it uses the existing base-ui Dialog and the `cn` import the other ui files use.
  If the registry has no base-nova `command`, use `cmdk` directly inside the existing `ui/dialog`.
- Opens with `Mod+K` (⌘K / Ctrl+K), from anywhere, including while focus is in the search box. Escape
  closes it and returns focus where it was. Opening it does not change the URL.
- Lists the enabled actions grouped (Go to, Filter and view, Select, Clean up, Trash, Help), shows
  each action's shortcut label on the right, fuzzy-searches names and keywords.
- While the palette is open, other page hotkeys do not fire (it is a dialog; the existing guards
  already skip while a dialog is open).

### Palette actions

Go to: Cleanup, Storage, Insights, Trash (hidden after a cancelled session, as the tabs are); each
cleanup section by title ("Go to section: Package manager caches").

Filter and view (Cleanup tab): Filter paths (`/`, focuses the box); Show safe / review / report only
(toggles); Minimum size: any / 100 MB / 1 GB / 5 GB; Minimum idle: any / 30 / 90 / 365 days; Sort: the
five orders; Only selected (toggle); Switch to list / cards (`V`); Clear filters. Storage tab:
Sunburst / Treemap.

Select (Cleanup tab, before approval): Select all shown (`A`); Clear selection (`D`); Reset to
recommended (`R`); in the open section: select all, idle 90+ days, idle 1+ year, none (same rules as
the quick-select buttons).

Clean up: Delete… (`Mod+⌫`, opens the confirm); Delete immediately… (opens the confirm in
"can't be undone" mode); Rescan (when the scan is done and not approved). After approval: Show
cleanup details; Watch the movie (not with reduced motion); Undo this cleanup; Empty these from
Trash… (opens the confirm).

Trash tab: Undo selected; Empty selected… (opens the confirm); Show all cleanups / Show cleanup of
<run> (the run filter).

Help: Keyboard shortcuts (`?`); How Delete works (opens the About deleting popover).

Not in the palette: Cancel (its fuse button with its undo window is the safeguard); dialog confirm
buttons; row checkboxes; chart pin, copy path, zoom (they need a pointed-at item).

## 5. Shortcut cheatsheet

- `?` (Shift+/) opens a dialog listing every registered shortcut, read from TanStack Hotkeys'
  `useHotkeyRegistrations()`, grouped by `meta.group`, labelled with `formatForDisplay` for the
  platform. It shows only shortcuts that exist in the current context, plus `Mod+K` and `?`.
- Not fired while typing in a field. Escape closes it. Opening it does not change the URL.

## Tests

Vitest browser tests (Chromium and Firefox, the existing `app *` projects), driving the page as a
user does: roles, labels and keys only.
- Platform: with `linux` the four texts and the Storage rows read as the table above, the labels read
  `Ctrl+⌫`, `Shift+Delete` opens the "can't be undone" confirm, `Ctrl+Alt+Backspace` does nothing;
  with `macos` every existing test passes unchanged.
- Palette: `Mod+K` opens it from the list and from the search box; typing filters; Enter runs
  "Go to Storage"; "Delete…" opens the confirm and deletes nothing; Trash actions only on the Trash
  tab; Undo only after a cleanup; Escape restores focus; page hotkeys do not fire while it is open.
- Cheatsheet: `?` opens it; it lists A, D, R, V, /, Delete keys, Mod+K, ?; typing `?` in the search box
  types a character instead.
- `cli/assets/page.html` is rebuilt with `pnpm run build` and committed (CI diffs it).

## Not in this change

Windows wording and keys (the Windows step), new actions beyond the list above, theme switching
(the page is dark only).

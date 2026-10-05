# disk-clean: hold, then free; confirm in a modal

## Goal

Two changes, decided 2026-10-03:

1. **Undo.** Approved items are not deleted right away. They are moved (renamed, same volume,
   instant) into a holding folder. The app offers an exact **Undo** and **Free the space now**;
   held items are freed automatically after a few days. Space comes back when they are freed.
   (macOS Trash was considered: it frees nothing until emptied either and Put Back for
   programmatic trashing is unverified; a holding folder gives an exact undo with no Finder
   dependency.)
2. **Confirm modal.** The Preview button and the Approve fuse go away. **Delete** opens a modal
   that shows exactly what will happen (the content Preview showed today) and the user confirms
   there. Claude's terminal dry-run step stays (user decision, unchanged).

## Hold

- `clean` (the worker) moves each approved path with `rename(2)` to
  `~/.cache/disk-clean/held/<run-id>/<n>` and appends to `held/<run-id>/manifest.jsonl` (one JSON object per line, appended before each move):
  `{original, held, bytes, held_at}`. `rename` is atomic and instant on the same APFS volume
  (home, `/private/tmp` and `$TMPDIR` are all on the Data volume).
- A path whose rename fails (other volume `EXDEV`, permission) is reported `not held` with the
  reason; it is never deleted by this step.
- Cannot be held, and say so everywhere (modal, dry run, panel): git worktrees (removed with
  `git worktree remove` as today; branch and commits stay, `git worktree add` restores) and the
  three fixed commands (docker prune, brew cleanup, simctl delete). These run as today, after the
  held moves, and are labelled "can't be undone".
- **Free**: deletes `held/<run-id>` in the background (same parallel remover as today), streams
  progress, then removes the manifest. Irreversible; has its own confirm.
- **Undo**: renames each held item back to `original`. If `original` exists again (e.g.
  `node_modules` was reinstalled), the held copy stays held and the row says why. Undo of a
  partially freed run restores what is still held.
- **Expiry**: held runs older than `DISK_CLEAN_HOLD_DAYS` (default 7) are freed automatically by
  the next `disk-clean` invocation (any subcommand), before it does anything else, and that is
  printed on stderr.
- The holding folder is excluded from the scan's normal sections and shown as its own section
  "Held by disk-clean" (per run, with age and size; selecting it = free).
- Free space: holding frees nothing. Every surface must say "held, not freed yet" and show
  "Free the space now"; the freed figure is only counted after Free.

## Confirm modal

- **Delete** (the old Approve button, label "Delete N items · X") opens a modal (shadcn Dialog,
  focus trapped, Escape cancels): totals, then grouped lists: "Moved to hold (undo available)" with
  every path and size, "Can't be undone" (worktree removals and fixed commands, with the exact
  command lines), and anything the safety checks rejected with the reason. Built by the same
  server code that `/preview` uses today.
- Confirm button: "Move N items to hold" (or "Delete N items" when nothing is holdable). Cancel
  closes the modal and changes nothing. No fuse afterwards.
- Cancel (the page's Cancel that ends the session) keeps its undo window.

## Actions after approval

`watch` gains two POST routes, the only mutations it allows: `/undo` and `/free`, token-checked
like `/decide` and additionally requiring `Origin`/`Host` to be the page's own
`http://127.0.0.1:<port>` (closes cross-site and DNS-rebinding POSTs). They act only on the
run's own manifest entries; they can never touch a path that is not in that manifest. Everything
else stays read-only. The page's header/panel show "Held X · Undo · Free the space now", then
progress and the result.

## Skill and CLI

- New subcommands `disk-clean undo RUN_DIR` and `disk-clean free RUN_DIR` (same code as the
  routes) so Claude can do it from the terminal too.
- Dry-run output shows the hold moves (`mv -- '<path>' '<held>'`) separately from the
  can't-be-undone commands.
- SKILL.md: explain hold / undo / free / expiry; after approval Claude reports "held X (undo
  available until <date>)".
- stdout and exit codes of `review` and `clean` unchanged.

## Movie and progress

Worker events: `held` replaces `removed` for held paths (`removed` stays for worktree removal);
new `freed` events during Free; `undone` during Undo. The in-app progress and the movie use the
same events; the finale says what was held and offers Free / Undo, and plays the "You freed"
payoff when Free completes.

## Tests

Rust: hold moves and manifest, EXDEV / permission → not held, undo (incl. conflict), free,
expiry on next run, held folder excluded from scan sections and shown as its own section,
`/undo` and `/free` token + Origin/Host checks and manifest-only scope, dry-run output. Browser:
Delete opens the modal with the grouped lists, Confirm sends the approval, Cancel changes
nothing, Escape closes, no fuse; after approval the Held state, Undo and Free with confirm.
Sandbox end-to-end (HOME and TMPDIR inside the sandbox): hold, undo, re-approve, free; files
verified on disk at each step.

# disk-clean: one session, the scan keeps going, Claude stays in the loop

Decided 2026-10-05 (the user, relayed from another session: "why do we have to kill the UI while we
delete stuff? can't we keep it running?"; then chose "Keep Claude in the loop" and "Never on its
own").

## Today (checked against review.rs at c9f8950)

- `review` serves the page and runs the scan thread. `decide()` waits up to `TIMEOUT` (1800 s,
  counted from launch) for a single decision, then `review` exits.
- Before exiting it hands its port and token to a detached `watch` process, which keeps the page
  alive, but the scan thread dies with `review`.
- Approving mid-scan cancels the scan on purpose. In run-20261005-011559 the user approved 13 s
  in: scan.tsv has 24 rows, and node_modules, worktrees and stale build artifacts were never
  listed.
- clean.log ends at the hold step. A Free started from the page shows only in clean.events, so a
  later `free RUN_DIR` answers "nothing is held". (trash.md replaces hold and free; the same lesson
  applies to Empty and Undo started from the page.)

## The shape

- **`review` is the one server for the whole session.** The `watch` handoff, with its port and
  token env, goes away.
- **Approval never cancels the scan.** The walk keeps listing. Paths already approved, trashed or
  removed are never listed again, nor anything inside them. Approval is still validated only
  against rows already shown (delete-while-scanning.md).
- **Claude stays in the loop for every cleanup:**
  - Each approval is written as a numbered decision (`decisions/<n>.json`, the selection plus the
    validated plan). The page shows "Waiting for Claude to run it" until the worker starts.
  - A new command, `disk-clean wait RUN_DIR`, blocks until there is a decision Claude hasn't run
    yet, prints its number and path, and exits. Claude Code wakes only when a background task
    exits, so this exit is the wake signal.
  - The loop in SKILL.md: launch `review` in the background, then `wait` in the background. On each
    wake, run `clean --dry-run RUN_DIR --decision N` (show the plan in the terminal), then
    `clean RUN_DIR --decision N`. Report the result, then start `wait` again.
  - `clean` takes `--decision N`. Cleanups run one at a time per run directory: a second approval
    while one runs waits in order (the page shows it as queued). Exit 4 becomes "queued", never an
    error the user has to retry.
- **The session never ends on its own.** No approval timeout, and no exit on tab close. It runs
  until Claude stops it with `disk-clean stop RUN_DIR` (token-checked, local only), when the user
  asks or says they're done. The page shows "Session open", and a closed tab can reopen to the
  same address.
- **One log of record.** Every action, wherever it was started (Claude's `clean`, Undo / Empty /
  Delete immediately from the page), appends to clean.log and clean.events alike, so the terminal
  and the page always agree. `wait` also wakes Claude for page-started actions, so Claude can
  report them in the terminal.

## Tests

- **Rust:**
  - Approval mid-scan doesn't stop the walk, and items listed after approval still arrive.
  - Approved paths, and paths inside them, are never re-listed.
  - Two approvals queue and run in order.
  - `wait` returns each decision once.
  - `stop` ends the session cleanly.
  - clean.log records page-started actions.
  - Every safety test stays green.
- **Browser (Chromium and Firefox):**
  - Approve mid-scan: the scan keeps going and the hero shows both phases correctly (one phase
    source, per the Trash lane's work).
  - A second approval shows as queued.
  - Reloading during a cleanup restores it.
- All tests run in sandboxes (RAM disk for the Trash), never against the real HOME.

## Order

This runs after the Trash lane (trash.md) lands. It changes the same worker, events and SKILL.md.

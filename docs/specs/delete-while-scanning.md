# disk-clean: Delete works while the scan is still running

Decided 2026-10-04. Seen on a real run: the walk took 104 s and the worktree checks and
Docker/Homebrew/simulator probes ran after it, and the whole time Delete was a greyed-out button
with no reason on it (the only hint was small grey text at the far left of the footer). Items on
screen were already measured and safe to act on.

## Rules

- **An item is deletable once it is listed.** When the server streams an item to the page, it also
  records it in the run's validated item index, appending to `scan.tsv` or an equivalent per-run
  record that `clean` and `/preview` read. `/preview` and `/decide` accept any listed item while the
  scan continues; `clean` still validates against that record, with every safety rule unchanged
  (canonical path, allowed, re-resolved right before the move).
- **Only rows still being checked are locked:**
  - worktrees whose safety check hasn't run yet;
  - the Docker/Homebrew/simulator command rows until their probe answers.
  Those rows show "checking…" in place of their checkbox and can't be ticked. Everything else is
  live.
- **Approving while scanning:** the confirm dialog lists exactly what is selected now. Confirming
  stops the scan (it is cancelled cleanly; the run is approved with what was listed). The dialog
  says so in one line: "The scan is still running; confirming stops it and uses what was found so
  far."
- **No dead button:**
  - Delete is enabled whenever at least one selected item is deletable.
  - When nothing is selectable yet, the button text says why ("Scanning… nothing found yet").
  - When the selection is empty, it says "Select items to delete".
  - Never disable a button without its own visible reason.
- **Rescan** keeps working as specified (rescan.md); items that disappear in a rescan drop out of
  the selection.

## Tests

- Rust:
  - `/preview` and `/decide` accept an item streamed before the scan finished, and reject a path
    that was never listed;
  - a `clean` of a mid-scan approval moves exactly the approved, listed paths;
  - cancelling the scan on approval leaves a consistent run dir.
- Browser (Chromium + Firefox):
  - with the fake stream mid-scan, Delete is enabled for listed items and the modal shows the
    "still running" line;
  - worktree and command rows show "checking…" and can't be ticked until their check event;
  - the button text matches each state above.

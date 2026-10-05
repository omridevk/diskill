# disk-clean: safety hardening and CLI correctness

From the QA pass of 2026-10-03 (build 023f4a9; evidence under the session scratchpad `qa/server/` and
`qa/cleanup/`). Every item below is a defect with a reproduction; each fix lands with a test that
fails before it.

## Blockers

- **SRV-1 Host/Origin.** `review` and `watch` accept any `Host`. A DNS-rebinding page can read the
  token from `GET /` and POST `/decide` (text/plain is a simple request). Fix: every request must
  carry `Host` exactly `127.0.0.1:<port>` or `localhost:<port>`, else 403; POSTs must also send
  `Content-Type: application/json` and, when present, an `Origin` equal to the page's own origin.
  The token stays.
- **SRV-2 delete-time path resolution.** `clean` validates paths as strings and `remove_tree` only
  `symlink_metadata`s the leaf, so a symlink swapped into any ancestor after the scan redirects the
  delete (proved: a decoy outside HOME was deleted; the worktree variant emptied a checkout outside
  HOME). Fix: right before each removal, resolve the parent with `realpath`, require
  `realpath(parent)/name` to equal the canonical scanned path, the result to be under the canonical
  allowed roots and outside every protected area, and the leaf itself not to be a symlink (a leaf
  symlink is unlinked, never followed). Same check before `git worktree remove`. Anything that fails
  is logged `KEPT` with the reason.

## Majors

- **SRV-3 canonical paths.** Reject (do not normalise) any path with `//`, a `.` or `..` component,
  or a trailing `/`; refuse to run with an empty, relative or non-existent `HOME`; protection rules
  compare canonical paths; protected names match case-insensitively (APFS default).
- **SRV-4 symlinked HOME.** Canonicalise `HOME` once at startup (`realpath`) and use that everywhere
  (scan, map, rules, clean), so a symlinked home scans fully and the walk-derived sections appear.
  Print the canonical home on stderr when it differs.
- **SRV-14** the temp-base allow rule must not let a HOME under `$TMPDIR` skip personal-folder
  protection: protection checks run first.
- **CLN-3 / SRV-5 quadratic planning.** `rm_rejection` re-splits scan.tsv per item. Index scan.tsv
  once per `plan` (path → row) and use the same index in `/preview` and `selection`. 10k items
  against a 14k-line scan must plan in well under a second (test with a generated scan).
- **CLN-1 / SRV-11 / MOV-5 the freed figure.** The headline "freed" is the sum of bytes of items
  actually removed (from the worker's `removed` events), everywhere: `done` event (`removed_bytes`),
  clean.log ("removed: N items, X bytes"), the page, the movie. The volume free-space change is
  reported separately and labelled as such ("free space changed by Y"), measured from worker start,
  never from the scan-time `free-before`.
- **CLN-2 reopened runs.** Each `clean` run starts a fresh `clean.events` (truncate, with a run id in
  `started`); the watcher and page only show the current run.
- **SRV-8** dedupe selection paths (selection.json, plan, worker).
- **SRV-9** `clean` takes an exclusive lock on the run dir (second concurrent `clean` exits with a
  clear error); a worker killed mid-run leaves `status` = `interrupted` on next look and the watcher
  exits; the watcher's never-started timeout is reported to the page (see CLN-4) rather than
  silently lingering.
- **CLN-4** the page gets a "the cleanup did not start" state when the watcher's start timeout
  fires or `clean` exits without events (the watcher sends a final `abandoned` event before exiting).

## Minors in the same code

- **SRV-6** cap request line + headers (16 KB), body (1 MB), total request time (10 s) and concurrent
  connections (64); excess gets 431/413/408/503.
- **SRV-7** `render` escapes every `<` in the embedded JSON as `<`.
- **SRV-10** SSE threads notice a closed client within a second (shorter heartbeat or a read probe).
- **SRV-11** `clean --dry-run` exit codes match the real run; a missing run dir prints a clear error;
  the dry run describes the worker's actual removal (not `rm -rf`).
- **SRV-12** the scan reports skipped too-deep paths (count on stderr and in disk.tsv).
- **STO-1** future or sentinel mtimes (`> now + 1 day`, `u32::MAX`) are ignored when propagating the
  newest change to parents.

## Tests

Rust integration tests for every item, including: a DNS-rebinding style request (foreign Host) is
403 on `/`, `/events`, `/decide`, `/preview`, `/rescan` and the watcher; the ancestor-symlink swap
and worktree swap keep the decoy; non-canonical paths and empty/relative HOME are rejected; a
symlinked HOME lists node_modules; 10k-item planning time; freed = removed bytes; a second clean run
truncates events; dedupe; lock; header caps. Sandbox end-to-end as in the QA runs (HOME and TMPDIR
inside the sandbox).

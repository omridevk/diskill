# disk-clean: one skill for any agent harness

Decided 2026-10-05 (user: "can we make this skill work with any AI harness?"). Runs after
one-session.md, which reshapes the same agent loop.

## Today

The CLI, the review page and the safety model don't depend on any harness. What's specific to
Claude Code:
- **Packaging:** the plugin, the marketplace (`mopper`), `plugin.json`, and the plugin root and
  data folder that `run.sh` receives as arguments.
- **The agent loop in SKILL.md:** it relies on Claude Code's background tasks and its wake on task
  exit.

## The shape

- **One SKILL.md for every harness,** in the open Agent Skills format (front matter with `name` and
  `description`, scripts next to it). The Claude Code plugin stays as one packaging of the same
  skill folder, not a fork. No harness-specific wording: no "run_in_background" and no
  `CLAUDE_PLUGIN_ROOT`. Paths are relative to the skill folder.
- **`run.sh` works without a plugin:**
  - With no data folder argument, it uses `~/.cache/disk-clean/bin/<version>`, downloads the
    release for its version, verifies the sha256, and falls back to `cargo build` as today.
  - The plugin passes its own data folder as now.
  - The version comes from one file in the skill folder, not from `plugin.json` alone.
- **Short commands only, so no harness needs background tasks or long timeouts:**
  - `review` starts the server and the scan, prints the page address and RUN_DIR, then returns.
    The server keeps running detached, per one-session.md.
  - `wait RUN_DIR [--timeout SECONDS]` returns when there is a decision to run, a page action to
    report, or the session stopped. Otherwise it returns after the timeout (default 240 s) with
    "nothing yet", and the skill says to call it again.
  - `clean --dry-run`, `clean`, `undo`, `empty` and `stop` stay one-shot.
  - The SKILL.md loop: `review`, tell the user to open the page, then repeat `wait` and act on
    what it returns until the user is done.
- **Install paths in the README:**
  - Claude Code via the mopper marketplace (as now).
  - Any other harness via `npx skills add omridevk/mopper --skill disk-clean`, or by copying the
    skill folder.
- **The plugin's built-in safety rules keep applying everywhere.** Nothing is deleted without
  approval in the page, and `clean` only acts on `selection.json` decisions the page wrote.

## Tests

- **Rust:**
  - `review` returns while the server keeps serving.
  - `wait` returns on a decision, on a page action, on stop, and on timeout.
  - Each decision is reported once across repeated `wait` calls.
- **Scripts:**
  - `run.sh` with no data folder downloads and verifies into the cache path (against a local
    test release), and refuses a checksum mismatch.
  - shellcheck.
- **Manual end to end (recorded in this spec):** install with `npx skills add` into Codex and one
  more harness, and run review, wait, dry run and clean on a sandbox HOME (never the real one).
  Note any harness that can't run the loop and why.

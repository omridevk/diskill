# disk-clean: the cleanup movie

## Goal

After Approve, the review page turns into a short film of the cleanup as it really happens:
items leave the disk as the worker deletes them, the free-space gauge climbs with the real
numbers, and it ends on what was actually reclaimed. Decided 2026-10-03: live data (not a recap of
the selection), GSAP timelines (the `gsap` package; all plugins are free, SplitText / Flip /
DrawSVG / MorphSVG allowed).

## Why a watcher

Today `review` exits right after approval (the skill reads `RUN_DIR` and `selection.json` from
its stdout, shows `clean --dry-run`, then runs `clean`, which detaches a worker). Nothing serves
the page after that. The stdout and exit-code contract stays exactly as it is; a separate
read-only process serves the page from then on.

- On approval, `review` spawns a detached `disk-clean watch RUN_DIR` (setsid, like the clean
  worker) with the page token and port in its environment, then exits as today.
- `watch` binds the same `127.0.0.1:PORT` (std sets SO_REUSEADDR) and serves `GET /events?token=`
  only. The page's EventSource reconnects on its own when `review` goes away.
- It never deletes, never runs commands, never accepts POSTs (404/405). It only reads the run dir.
- It exits when the worker's `done` has been streamed and no client has been connected for
  60 seconds, or after 45 minutes no matter what, or if `clean` never starts within 30 minutes.

## Worker events

`clean --worker` additionally appends one JSON object per line to `RUN_DIR/clean.events`
(clean.log stays as is, it is the human log). `elapsed_ms` is time since the worker started.

| event | fields | when |
| --- | --- | --- |
| `started` | `free, paths, worktrees, commands, bytes` | worker start (bytes = planned total) |
| `removed` | `path, bytes, secs` | a path is gone (bytes from the plan) |
| `failed` | `path, bytes, reason` | still present after removal |
| `worktree` | `path, bytes, outcome: removed\|kept, reason` | each worktree after its re-check |
| `command` | `id, label, status` | each fixed command finished |
| `free` | `free` | statfs sample, at most every 500 ms while working |
| `done` | `free_before, free_after, reclaimed` | worker finished |

`watch` streams them as SSE events of the same names, replaying the file on connect, then tailing
it. Before the file exists it sends `waiting` once (Claude is showing the dry run).

## The film (page)

Built with GSAP timelines in React (`useGSAP` from `@gsap/react` for cleanup), driven by the live
events; each event appends a beat to a master timeline so beats never overlap or drop.

1. **Approve**: the fuse burns out and the whole review UI collapses into the approved total
   (Flip from the summary number to centre stage). Reuse the existing Approved-screen pieces
   (Burning Film backdrop, ParticleText total, Shredder) where they serve the story; drop what
   does not.
2. **Waiting**: a calm idle loop with "Waiting for the deletion to start" while Claude shows the
   dry run. No fake progress.
3. **Deleting**: each `removed` item appears as a card with its label and size and leaves (shred,
   dissolve, or into the ring), its bytes counting into a "reclaimed" counter. Sections from the
   selection are rows/rings that fill as their items go. The disk bar morphs as real `free`
   samples arrive. `failed` and `kept` worktrees get their own visible beat with the reason, never
   silently skipped. When many items land at once, beats batch (keep up with the real worker; the
   film may lag it by at most ~2 s).
4. **Finale** on `done`: "You freed X" with the real `reclaimed` figure, before→after disk bar,
   stats (items, sections, biggest item, time taken, kept/failed counts), then a credits roll of
   everything removed. Replay button scrubs the master timeline from the start.

Before coding, write a beat sheet (`docs/specs/cleanup-movie-beats.md`): every beat named with its
exact motion term from the `animation-vocabulary` skill (e.g. Flip / shared-element, stagger,
count-up, morph, mask reveal), its duration and easing, and the event that triggers it. It is
reviewed before implementation. Skills to load: `animation-vocabulary`, `motion-graphics`,
`animate`, `fixing-motion-performance`, `review-animations` (self-review pass at the end).

Rules: transform/opacity/filter only (no layout animation), 60 fps on the real machine with
hundreds of items, canvases paused when hidden, everything stops after the finale settles (no
endless GPU loop on an idle tab). Reduced motion: no film; a static live list and the final numbers.
Connection lost after `done`: the finale stays.

## Out of scope

Exporting a video file, sharing, sound.

## Tests

- Rust: `watch` replays and tails `clean.events`, sends `waiting` before it exists, rejects bad
  tokens and POSTs, exits on its rules (use short timeouts via env in tests). Worker writes the
  events above for a run with rm paths, a kept worktree and a failed path.
- Browser: feed `waiting`, `started`, `removed`×N, `failed`, `worktree kept`, `free`, `done` through
  the fake event source: the reclaimed counter ends at the real figure, kept/failed are shown with
  reasons, the finale shows `reclaimed`, reduced motion renders the static list.

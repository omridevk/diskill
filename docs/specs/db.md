# disk-clean: the page's data layer on TanStack DB

Decided 2026-10-03. Starts after hold-and-confirm lands (it changes `lib/cleanup.ts`).

## Why

The page is two live streams plus many derived views. Today every derived view is a hand-written
reducer or cache (`lib/scan.ts`, `lib/cleanup.ts` with its dedupe key map, cached `outcomes()`,
per-frame batching, run-id resets), and QA traced several defects to that code (O(n²) copying,
an old run's events shown as new, double counting). TanStack DB's collections and incrementally
maintained live queries replace it.

## Design

- Load the official skills first: `pnpm dlx @tanstack/intent@latest list`, then `load` the
  `@tanstack/db` / `@tanstack/react-db` skills (collections, live queries, custom sync, mutations)
  and follow them. Install exact latest `@tanstack/db` and `@tanstack/react-db` (TanStack packages
  are pre-approved).
- **Collections**, filled by a custom sync from the existing EventSource streams (one `begin/write/
  commit` per animation frame batch):
  - `items`: scan items keyed by path (`item` events upsert; on `done` of a rescan, rows not
    reported by that scan are deleted, matching rescan.md), with their section;
  - `sections`: section heads keyed by id;
  - `disk`, `progress`, `scan`: single-row state (volume figures, walk progress, phase);
  - `events`: cleanup events keyed by `(run, kind, path|id)`, so replays and duplicates are no-ops
    by key; a new `run` id replaces the collection's contents.
- **Live queries** for every derived view: the table's filtered/sorted rows (fed to TanStack Table
  as data; Table keeps sorting/grouping/selection UI), section totals and counts, footer and summary
  totals (nested paths counted once), storage card "cleanable inside / selected", per-row outcome
  (join items × events), progress figures, finale totals, the movie's outcome stream.
- **Selection** stays TanStack Table row selection (table.md); the first-seen preselection rule reads
  from `items` inserts.
- **Mutations** (approve, undo, free, rescan) as optimistic actions that POST to the server and roll
  back on refusal.
- Delete the hand-written reducers and caches this replaces; no parallel path left behind.

## Done when

All existing browser tests (app, router, film in Chromium/Firefox/retina) and Rust tests pass with
the same meaning; the perf project stays within its budgets and the report compares React work
per interaction/batch before vs after (10k-row section, 5k-event cleanup, 9k-item streaming scan);
bundle size before/after is reported; the reducers' modules are gone.

## Live queries do the shaping (added 2026-10-04)

Measured after the first cut: per-batch cost still grew with list size because TanStack Table rebuilt
its whole filtered/grouped/sorted row model on every data change, and the URL selection was decoded
in full on every tick. Fix, per the TanStack DB live-queries guide:

- Search, risk/size/age filters and sort are the live query's `where` / `orderBy` (with `limit`
  where a window is enough). Section totals and counts are `groupBy` + `sum`/`count`. These are
  maintained incrementally, so a streamed batch or a filter change costs in proportion to what
  changed. TanStack Table receives the already-shaped rows of the open section and does selection,
  keyboard and rendering (table.md's "Table owns filtering/sorting" is superseded by this).
- The URL search params stay the source of truth for filters and sort; the live query reads them.
- Selection decodes incrementally (only changed tokens). Totals derived from it use
  `useDeferredValue`, so a tick never waits on them. Change-driven work uses the live query's
  `createEffect` / `onBatch`, not a full re-read.
- TanStack Table v9's `workerRowModelsFeature` (experimental) is the fallback if a row model still
  has to be computed in the table; not used unless measurement says so.
- Perf tests assert flatness: the cost of one streamed batch, one tick and one filter keystroke at
  10k rows stays within a small factor of the 30-row baseline (median and p95), in both browsers.

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
- Reference implementations: TanStack Table's `examples/react/realtime-trading` (worker-produced
  fixed-interval batches, immutable snapshots, table-owned row models, `table.Subscribe`, row
  boundaries, Virtual, Profiler) and `examples/react/kitchen-sink` (`@tanstack/react-hotkeys`,
  `@tanstack/react-pacer`). Whether rows are shaped by the live query or by the table's row models
  is decided by the flat-cost measurements below, both measured; the winner is recorded here.
- TanStack Table v9's `workerRowModelsFeature` (experimental) is the fallback if a row model still
  has to be computed in the table; not used unless measurement says so.
- Perf tests assert flatness: the cost of one streamed batch, one tick and one filter keystroke at
  10k rows stays within a small factor of the 30-row baseline (median and p95), in both browsers.

### Outcome (measured 2026-10-04)

The live query shapes the rows; the table only renders and selects. React work per change at
10,000 rows vs 30 rows (median / p95, ms):

| | table row models (before) | live query shapes (after) |
|---|---|---|
| Chromium batch | 16.3 / 20.6 vs 4.4 / 5.2 | 3.7 / 4.2 vs 2.9 / 3.3 |
| Chromium tick | 2.9 / 3.3 vs 2.4 / 2.9 | 2.9 / 3.2 vs 2.2 / 2.5 |
| Chromium keystroke | 8.3 / 14.5 vs 1.5 / 2.6 | 4.6 / 7.0 vs 2.1 / 3.5 |
| Firefox batch | 30.9 / 51.0 vs 16.4 / 190.8 | 5.5 / 13.3 vs 4.2 / 10.4 |
| Firefox tick | 9.8 / 15.1 vs 3.9 / 7.7 | 4.5 / 6.7 vs 3.0 / 3.7 |
| Firefox keystroke | 14.5 / 113.0 vs 3.1 / 11.9 | 6.6 / 28.1 vs 4.2 / 25.6 |

Why it wins: with table-owned row models every streamed batch hands the table a new data array, and
its core/filtered/grouped/sorted row models are rebuilt over all rows (O(n) per batch);
`table.Subscribe` and row boundaries cut re-rendered rows, not that rebuild. With the live query, a
batch updates the per-section `groupBy` totals and the open section's `orderBy`/`limit` window
incrementally, and the table holds only the window (about 120 rows) the virtualizer is showing.

Shape: `useShapedTotals` (filtered count, bytes, selectable, aged per section) and
`useSectionWindow` (open section, sorted, `limit`/`offset` moved by the virtualizer's `onChange`).
Live queries are cached per filter key. A new search string still needs one pass over the items to
build its query (substring match cannot use an index): that build runs in the debounced search
handler (`prepare`), outside React, and cost about 18 to 28 ms in Chromium and 90 to 160 ms in
Firefox at 10,000 rows. No worker and no `workerRowModelsFeature`: the table no longer computes a
row model over the section, and SSE parsing did not show in the profiles.

### QA round 2: the section index replaces the shaping live queries (2026-10-04)

Profiled in real Firefox on the built page with 12,000 rows (Gecko profiler, unminified build): every
new filter key, sort or only-selected value built a new live query collection, and its first graph
run hashed every row (`hashObject`, `writeByte`, `isBinaryValue` in db-ivm): about 140 to 340 ms per
query, synchronous, on the interaction. While a scan streamed, each typed key added another live
query that every later batch also flowed through (4.2 s of graph runs in a 10 s window). The open
section and the per-section totals are now kept in a plain incremental index over the scan store's
per-section maps: a sorted array per section and sort, patched by binary insertion when a batch
changes few rows, filtered per filter key (one predicate pass), and per-section totals cached by
section version. The table still receives only the window the virtualizer shows. The cleanup
event views stay live queries. Frame numbers are in qa-round-2.md, section C.

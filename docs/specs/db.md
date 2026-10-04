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

## Live queries, done right (2026-10-04)

Profiled 858b272's shaping in headless Firefox (Gecko profiler, 0.5 ms sampling, built page in
production mode, 12,000-row section) and in a DB-only bench of the same queries. Each new live query
cost 50 to 290 ms in Firefox. Two separate costs, both ours to start with:

**1. The window query loaded the whole section and inserted it row by row (our usage).**
Call path: `createLiveQueryCollection` > `startSync` > `maybeRunGraph` > `TopKArray.insert` (db-ivm
`topKArray`, binary search plus `splice` per row, plus a fresh fractional index key per row): 38%
of all samples. DB only reads `offset + limit` rows from an index when the plan allows it.
`compiler/order-by.ts` sets `requiresFullSource` when the query has any `fn.where` or a
`stringSort: 'custom'` order, and `currentStateAsChanges` (`collection/change-events.ts`,
`getOrderedKeys`) only uses `index.takeFromStart` for a single-column `orderBy`. 858b272 had all
three: `.fn.where(keep)`, the `Intl.Collator` comparator for name, and tie-breaker `orderBy`s on
`bytes` and `path`. So every query pushed every section row through top-K, an O(n²) insert.

**2. Section totals hashed every row on every new filter (DB, not avoidable by usage).**
Call path: `groupBy` > `ReduceOperator.run` > `Index.addValue` > `ValueMap.addValue` > `hash` >
`hashObject` > `writeByte` / `update` / `isBinaryValue` (murmur over every key and string): 69% of a
totals query. The WeakMap hash cache never hits because the hashed objects are not our rows: db-ivm's
`groupBy` (`operators/groupBy.ts`) builds a new pre-aggregate values object per row (group key
object, virtual-metadata object, group representative carrying the row key, one field per
aggregate), and the reduce Index hashes each one because all rows of a section share one reduce
key. Our row objects stay stable (the virtual-props cache returns the same enriched row); the cost
is per row, about 8 µs in Chromium and 12 µs in Firefox, so 100 to 160 ms per new filter at 12,000
rows. This is upstream's own finding in the open TanStack DB PR #1645 ("perf: systematic live query
engine optimizations", section 6, "groupBy/reduce without structural hashing"), not released:
`@tanstack/db` 0.11.3 / `db-ivm` 0.1.25 are the latest on npm.

**Also found:** `inArray(i.path, paths)` evaluates `array.some` per row (O(rows x selected)): 25 s
for 6,000 selected paths at 12,000 rows. PR #1645 section 4 adds the key-field fast path; until then
"only selected" stays a `fn.where` (with `queryKey`), which needs a full-source load.

### What changed

- `lib/shaping.ts`: `useLiveQuery` owns every query (`queryKey` from the filter key, `gcTime`
  500 ms); no module cache, no hand-rolled index or listener store, `createWindows` gone.
- Expression `where` (`eq` section, `like` on the lower-cased `search` field, `inArray` risk, `gte`
  size and age); one `orderBy` column per sort so the auto-index serves the window (`autoIndex:
  'eager'` on the items collection); the name sort reads a precomputed `order` field (accents
  stripped, lower-cased, digits zero-padded) with `stringSort: 'lexical'`. Ties break by row key
  (path).
- Totals: one always-live unfiltered `groupBy` query, plus a filtered one that is a disabled
  conditional query (`query` returns `undefined`) when no filter is set, so clearing a filter costs
  nothing.
- The scroll window is `setWindow` on the live query. `getWindow()` reports the settled window,
  which lags the rows DB publishes synchronously from `setWindow`, so the hook keeps the requested
  window next to the collection it belongs to.
- The 858b272 "Nothing matches these filters" bug: the module cache handed back a collection that
  had been cleaned up after `gcTime` with no subscribers; render read its empty `toArray`, and
  resubscribing restarted its sync without notifying the new subscriber, so the totals stayed empty.
  With `useLiveQuery` owning the queries that cannot happen; a browser test leaves Cleanup for 6 s
  and comes back. An empty list with no filters set says "Nothing to clean up." and offers no
  "Clear filters".

### Frames (largest frame, ms; `frames` project, 12,000 rows, headless)

Before = 858b272's shaping, hand-rolled = 7c3b80a's index, after = this change, all on the same tree.

| interaction | Firefox before / hand-rolled / after | Chromium before / hand-rolled / after |
|---|---|---|
| idle open section | 100 / 33 / 33 | 100 / 50 / 33 |
| idle filter first keystrokes | 358 / 17 / 167 | 133 / 17 / 100 |
| idle filter cleared | 9 / 9 / 9 | 17 / 17 / 17 |
| idle only selected | 276 / 9 / 251 | 117 / 17 / 100 |
| idle only selected off | 9 / 9 / 9 | 17 / 17 / 17 |
| idle risk toggle | 292 / 9 / 200 | 133 / 17 / 83 |
| idle risk toggle off | 9 / 9 / 17 | 17 / 17 / 17 |
| idle sort by name | 108 / 42 / 50 | 67 / 17 / 17 |
| idle sort by size | 25 / 33 / 25 | 17 / 17 / 17 |
| walking open section | 291 / 58 / 58 | 67 / 17 / 17 |
| walking filter first keystrokes | 258 / 17 / 234 | 133 / 17 / 67 |
| walking filter cleared | 9 / 9 / 12 | 17 / 17 / 17 |
| walking only selected | 258 / 9 / 400 | 117 / 17 / 100 |
| walking only selected off | 17 / 9 / 9 | 17 / 17 / 17 |
| walking risk toggle | 420 / 25 / 318 | 133 / 17 / 67 |
| walking risk toggle off | 9 / 9 / 9 | 17 / 17 / 17 |
| walking sort by name | 100 / 25 / 49 | 67 / 17 / 17 |
| walking sort by size | 25 / 25 / 17 | 17 / 17 / 17 |
| stream streaming | 42 / 42 / 34 | 17 / 50 / 17 |
| stream interacting while streaming | 400 / 33 / 192 | 133 / 17 / 83 |
| stream streaming to the end | 9 / 9 / 10 | 17 / 17 / 17 |

Sorting, opening, clearing and streaming are within budget. Filter keystrokes, the risk toggle and
only-selected are not: each builds a new filtered totals `groupBy` (cost 2 above), and only-selected
also loads the whole section through `fn.where`. With the filtered totals switched off as an
experiment, filter keystrokes and the risk toggle in Firefox fell to 17 ms and only-selected to
125 ms (its `fn.where` full load), so the rest is the `groupBy` hashing. Options for the user: (a) a local `pnpm patch` of `@tanstack/db-ivm` and
`@tanstack/db` with PR #1645's groupBy discriminant and key-field `inArray` path (needs approval);
(b) wait for PR #1645 to ship and upgrade; (c) accept the cost until then.

### Round 2: query shapes DB serves without a graph (2026-10-04)

Measured in headless Firefox (Gecko profiler, DB-only benches at 12,000 rows, and the `frames`
project). Every cost round 1 left was a query shape, not a DB defect:

**1. Totals: `groupBy` hashes a per-row values object, and re-reduces the whole group per batch.**
Call path: `groupBy` (`db-ivm/operators/groupBy.ts`) maps each row to a new values object
(virtual metadata, one group representative per group key whose `key` is
`serializeValue([rowKey, identity])`, so it carries the full path string, and one field per
aggregate) > `ReduceOperator.run` > `Index.addValue` > `ValueMap.addValue` > `hash` >
`hashObject` > `writeByte`. The objects are new per row, so the WeakMap cache never hits, and
slimming the `select` cannot remove the path string. `reduce` also recomputes every aggregate over
all values of each touched group, so the always-live unfiltered totals cost about 20 ms per
300-row batch in Firefox (O(section) per batch). Per-section single-group aggregates (no
`groupBy`) still hash: 110 to 300 ms per filter.

**2. A plain filtered live query does not hash, but compiles a graph and materializes every row.**
Profile of `from(items).where(like(...))` at 12,000 rows: 35 to 45 ms per build in Firefox, spent in
`maybeRunGraph`, `flushPendingChanges`, `enrichWithVirtualProps` (a copy of each row) and
`evaluateLike` (run twice: pushdown and the D2 filter). No `hashObject`.

**3. DB pools eq-filtered queries.** `resolveLiveQueryValue` (`live-query-options.ts`, used by
`useLiveQuery` when there is no `DbProvider` and no Suspense) serves a query with no `select`,
`join`, `groupBy`, `limit` or `fn.*`, at least one `eq(field, literal)` and optionally an
`orderBy` on row fields, from a shared partition of the source (`query/pooled-live-query.ts`): one
source subscription per field set and order, a sorted group per literal, and the remaining
conjuncts evaluated as a predicate over the group. No graph, no materialization, no hashing.
Firefox, 12,000 rows: unfiltered view 1 ms, filtered view 10 to 21 ms, a new sort's partition
22 to 66 ms once.

**4. `inArray` is O(rows x values)** (`evaluators.ts`, `array.some(valuesEqual)`, about 0.7 µs per
comparison in Firefox): 20 values over 12,000 rows cost 176 ms, 200 cost 1.5 s. A keyed join is
O(selected) (2,000 selected keys: 19 ms, 6,000: 59 ms), and a long-lived `items leftJoin picks`
costs 104 ms to build and 3 ms per pick change, but needs the URL selection (tokens, whole-section
picks, preselect) decoded inside DB, a second selection model next to the decode.

**5. `getWindow()` reports the settled window.** `setWindow` returns `true` only when the load
settles synchronously; with an index-driven ordered load it returns a promise, and `getWindow()`
and the rows move together only when it resolves. Round 1's `useState` offset covered that gap.

### What changed

- Totals: three per-risk live queries, `where(and(eq(i.risk, r), ...filters))`, which DB pools,
  plus three unfiltered ones, summed per section in a `useMemo`. No `groupBy`. A risk the filter
  excludes is a disabled query, so the risk toggle filters nothing.
- Section rows: one live query per open section, `where(and(eq(i.section, id), ...filters))` with
  the sort's `orderBy` and no `limit`, served from a pooled sorted partition. The table receives
  the virtualizer's visible slice of those rows, so `setWindow`, the window offset state and the
  `limit`/`offset` plumbing are gone. `gcTime` 5 s keeps the previous sort's partition warm.
- Only selected: the decoded selection filters the section's rows and the per-section sums in the
  same `useMemo` (O(rows), about 1 ms), because DB has no O(1) membership operator in 0.11.3 and
  the selection is not data in DB. The join above is the DB alternative if the selection moves
  into a collection.
- No `inArray`, `fn.where`, `groupBy`, `queryKey` or `setWindow` left in `lib/shaping.ts`.

### Frames (largest frame, ms; 12,000 rows, headless; 66c7450 / now)

| interaction | Firefox | Firefox reduced | Chromium | Chromium reduced |
|---|---|---|---|---|
| idle open section | 33 / 41 | 34 / 33 | 33 / 50 | 50 / 33 |
| idle filter first keystrokes | 167 / 50 | 183 / 58 | 100 / 33 | 100 / 17 |
| idle only selected | 251 / 16 | 242 / 42 | 100 / 17 | 117 / 17 |
| idle risk toggle | 200 / 17 | 158 / 9 | 83 / 17 | 83 / 17 |
| idle sort by name | 50 / 68 | 42 / 67 | 17 / 17 | 17 / 17 |
| idle sort by size | 25 / 25 | 17 / 17 | 17 / 17 | 17 / 17 |
| walking open section | 58 / 33 | 41 / 58 | 17 / 17 | 17 / 17 |
| walking filter first keystrokes | 234 / 42 | 175 / 50 | 67 / 17 | 83 / 17 |
| walking only selected | 400 / 17 | 242 / 9 | 100 / 17 | 100 / 17 |
| walking risk toggle | 318 / 25 | 332 / 26 | 67 / 17 | 67 / 17 |
| walking sort by name | 49 / 42 | 33 / 57 | 17 / 17 | 17 / 17 |
| streaming | 34 / 33 | 50 / 25 | 17 / 33 | 17 / 17 |
| interacting while streaming | 192 / 75 | 208 / 25 | 83 / 17 | 67 / 33 |
| streaming to the end | 10 / 9 | 10 / 9 | 17 / 17 | 17 / 17 |

Cleared/off rows stay at 9 to 34 ms. Every interaction is within budget in both browsers. Under
a machine load average of 10 one Firefox stream run hit 75 / 133; three reruns gave 33-42 / 67-75.

Remaining cost: a new search string evaluates `like` over every row of the risk and section groups
(the pooled view runs its predicate once to seed its subscription and once per snapshot read), so
the perf project's keystroke flatness check still fails: 27 ms at 10,000 rows vs 4 ms at 30 in
Firefox, 19 vs 3 in Chromium (66c7450: 133 vs 11 and 72 vs 6). The first use of a sort builds its
partition (name: 50 to 68 ms frames in Firefox).

### Round 3: flat search, and the first open while walking (2026-10-04)

**Keystroke cost, call path.** `useSectionRows` / `useRiskRows` > `useLiveQuery` (the query's
identity changes with every new `q`) > `resolveLiveQueryValue` > `createPooledLiveQuery` (a view with
a `like` residual) > `useSyncExternalStore` `getSnapshot` > `LiveQueryObserver.getSnapshot` >
`refreshDetachedState` > `captureEntries` > `PooledLiveQuery.entries()` (`[...rows].filter(passes)`)
> `rowPredicate` > `evaluateLike` (`compiler/evaluators.ts`). `evaluateLike` is a ReDoS-safe
two-pointer walk that visits every character of the row's `search` text (about 70 characters: label,
path, section title, note) even after the pattern has matched, because the trailing `%` consumes the
rest one character at a time. Instrumented per keystroke in Chromium at 10,000 rows: the open section's
view 7.0 ms and the risk views 5.6 ms of 17.9 ms React work; the rest was flat. DB-only bench (Node,
10,000 rows, pooled `eq` + `orderBy` view built and read): 1.35 ms without `like`, 9.2 ms with it, so
`like` costs about 0.4 to 0.75 µs a row, twice per keystroke (section view and its risk group).

**Directions measured:**
1. *Narrowing over the previous result.* A pooled view over a live query collection builds a new
   partition of that collection in render: 11.4 ms for `%item-00%` over the 10,000-row `%item-0%`
   result, against 9.2 ms straight from `items`. It also cannot help the perf test's alternation
   (`item-0` and `item-00`): every other keystroke widens the result, so it rebases on the source.
   Dropped.
2. *An index for search.* `like` is in `IndexOperation`, but `optimizeQueryRecursive`
   (`utils/index-optimization.ts`) only routes `eq`, `gt`, `gte`, `lt`, `lte`, `and`, `or` and `in` to
   an index, and a pooled view never consults indexes for its residual. A custom `IndexInterface`
   that answers `like` would never be asked. 0.11.3 is the newest `@tanstack/db` on npm. Dropped.
3. *Unrelated sums.* The three unfiltered totals views keep their identity while typing and their
   `useMemo` does not rerun; only the filtered totals recompute. Already stable.
4. *A shorter search field.* `like` over the 16-character label alone still costs 2.6 ms per 10,000
   rows (the predicate machinery per row), and the path and note must stay searchable. Dropped.

**What changed.** The live queries carry only what DB evaluates cheaply: `eq` section or risk, `gte`
size and age, and the sort's `orderBy`. Search text and only-selected are checked by `predicateOf`
in a `useMemo` over those rows (`String.includes`, about 0.05 µs a row), the same shape round 2
already used for only-selected. Typing no longer changes any query's identity, so a keystroke builds
no view and reads no group; DB keeps serving the rows incrementally while a scan streams.

**First open while walking.** Profiled in headless Firefox with reduced motion during a real walk
(Gecko profiler, 0.5 ms samples). The section's sorted partition is already warm: the page opens on
the first section with the same `{section}` + `size-desc` shape, and a pooled partition is shared
by shape, so opening another section is a group lookup. The open frame is React rendering the panel
(TanStack Virtual's `getMeasurements` calls `estimateSize` and `getItemKey` for all 12,000 rows),
the commit and layout, and 5 to 8 ms in DB's snapshot. Nine runs gave 42 to 75 ms; the 359 ms frame
did not reproduce. During this lane the machine's load average ran 18 to 42 from other work, and an
A/B of the streaming test under that load failed on the old code as often as on the new (streaming
50 to 217 ms on both), so the 359 ms frame reads as host contention, not a DB build.

**Perf (`one change at 10,000 rows`, keystroke median, React work, 10,000 rows vs 30).**

| | before (orchestrator, 8366bbc) | after, quiet host | after, full matrix (load average 23 to 31) |
|---|---|---|---|
| Chromium | 20.1 vs 2.3 (bound 11.0, fail) | 7.3 vs 3.3 | 7.1 vs 1.7 (bound 9.1, pass) |
| Firefox | 31.5 vs 5.4 (bound 20.3, fail) | 18.3 vs 8.4 | 35.3 vs 11.0 (bound 37.0, pass) |

What remains per keystroke is O(rows) in plain JS: the `useMemo` filters (section rows and totals),
the selection counts in `cleanup.tsx` (`pickedOf`, `hidden`) and TanStack Virtual measuring the new
row count. No DB view is built or read.

**Frames (largest frame, ms; 12,000 rows, headless).** The full matrix ran once: app 216/216, perf
both browsers, frames Chromium and Chromium reduced passed; frames Firefox and Firefox reduced failed
while other sessions' `tsc` and jest runs held the load average at 31 to 61 (failures included paths
this change does not touch: the streaming phase at 208 ms with 13 frames in 1.2 s, the risk toggle
off at 233 ms, filter cleared at 116 ms). Both reran once at load 10 to 15 and passed:

| interaction | Firefox | Firefox reduced | Chromium | Chromium reduced |
|---|---|---|---|---|
| idle open section | 41 | 34 | 50 | 67 |
| idle filter first keystrokes | 17 | 17 | 17 | 17 |
| idle only selected | 17 | 10 | 17 | 17 |
| idle risk toggle | 9 | 16 | 17 | 17 |
| idle sort by name | 59 | 83 | 33 | 33 |
| walking open section | 51 | 59 | 17 | 17 |
| walking filter first keystrokes | 25 | 26 | 17 | 17 |
| walking only selected | 17 | 17 | 17 | 17 |
| walking risk toggle | 24 | 33 | 17 | 17 |
| walking sort by name | 50 | 85 | 17 | 33 |
| streaming | 42 | 35 | 17 | 17 |
| interacting while streaming | 50 | 42 | 33 | 17 |

Cleared/off rows and sort by size stay at 9 to 50 ms. The first use of the name sort still builds its
partition (50 to 85 ms in Firefox), within budget.

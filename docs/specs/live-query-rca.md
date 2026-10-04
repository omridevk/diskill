# disk-clean: why our live queries are slow (root cause before any workaround)

Decided 2026-10-04. QA round 2 measured 140 to 340 ms in Firefox each time a new filter key, sort
or only-selected value built a live query over a 12,000-row section, and up to 3.1 s of frames
while typing during a stream. The QA lane replaced the shaping live queries with a hand-rolled
sorted index (`lib/shaping.ts`, commit 85040aa) plus a hand-rolled listener store for the scroll
window. The user rejected that: "you must be doing something wrong... TanStack DB is known to work
with such big data, something is off." TanStack DB is built for exactly this size, so the cost is
ours until proven otherwise.

## What looks wrong already

- The rows are small flat objects (`Entry`: about 15 primitive fields), and db-ivm caches every
  object's structural hash in a WeakMap (`db-ivm/dist/esm/hashing/hash.js`, `hashCache`). Hashing
  12,000 such rows once should take a few ms, and a second query over the same row objects should
  hit the cache. A profile dominated by `hashObject` / `writeByte` on every new query means we hand
  DB new objects each time, hash something big, or measure the wrong thing.
- `shaping.ts` at 858b272 created one live query collection per filter key with `.fn.where(...)`,
  a JavaScript predicate DB cannot index, optimise or push down, and ordered with
  `{stringSort: 'custom', compare: collator.compare}`.
- No collection declares indexes or `autoIndex`, so `orderBy` + `limit` cannot read only the top
  rows through an index.

## The work

1. **Reproduce and profile first.** On qa-round-2's parent (858b272: the live-query shaping),
   profile in real Firefox (built page, 12,000 rows, Gecko profiler) and name the exact cost:
   which function, called from which DB operator, on which objects, and why the hash cache does
   not hit. Record the call path, not just the leaf function.
2. **Read the DB source and docs before changing anything:**
   - the live-queries guide (https://tanstack.com/db/latest/docs/guides/live-queries): expression
     `where` (`eq`, `gte`, `ilike`, `inArray`, `and`, `or`), indexes, `orderBy` with `limit` and
     `offset`, `setWindow`, `useLiveQuery` with dependencies, `includes`, and lazy loading;
   - `@tanstack/db` 0.11.3 / `db-ivm` 0.1.25 source in `node_modules`, especially how a query's
     first run loads its source collection, how `orderBy` + `limit` uses an index (`autoIndex`,
     `createIndex`), and what gets hashed per row;
   - the GitHub issues and CHANGELOG for live-query performance with large collections (search
     before assuming a DB bug; never propose filing upstream issues).
3. **Fix it the DB way.** Shaping goes back on live queries, written the way DB is meant to be
   used. Likely parts, decided by the profile, not assumed:
   - expression `where` instead of `.fn.where`, so DB can index and push predicates down; search
     via `ilike` on a lower-cased search field (or whatever the docs recommend for substring);
   - indexes on the sorted and filtered fields (`bytes`, `age`, `section`, the name sort key,
     `risk`), so `orderBy` + `limit` reads the window through the index instead of sorting all
     rows;
   - one stable live query per open section whose parameters change (dependencies or the
     documented way to change a query), not a new collection per keystroke left alive in a cache;
   - stable row objects: a row object only changes when its data changes (so hashes stay cached);
   - the name sort through a precomputed sort key field instead of a custom comparator, if the
     comparator defeats the index.
   If a real DB limitation remains after idiomatic usage, show it in the profile and the source,
   and bring it back as a finding with options (a local patch to a TanStack package needs the
   user's approval first). Do not hand-roll an index around DB again.
4. **The scroll window** lives in DB (`setWindow` on the live query, as before) or in the URL, not
   in a hand-rolled listener store. Remove `createWindows`.
5. **Budgets** stay as in qa-round-2.md C and the existing `frames` project: no frame over 50 ms
   while streaming, no interaction over 100 ms, Firefox and Chromium, 12,000 rows, idle and during
   a real walk, with and without reduced motion. Record before (858b272), the hand-rolled index
   (7c3b80a) and after, in db.md under a new "Live queries, done right" section, with the profile
   finding.

## Rules (unchanged, all of them)

- TanStack DB only: no TanStack Store, no hand-rolled stores or listener sets, no direct
  `useQuery`/`useMutation`.
- No `useEffect`/`useLayoutEffect`, and no data-keyed ref callbacks (no-effects.md).
- Every UI state in the URL; route files own their UI.
- Functions, not classes; no IIFEs; no code comments; no em dashes.
- TanStack packages may be upgraded if a newer version fixes the cost (check the CHANGELOG);
  anything else needs the user's approval first.

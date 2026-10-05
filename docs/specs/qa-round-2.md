# disk-clean: QA round 2 fixes

From four Sonnet QA passes on ui-v2 13010b4 (2026-10-04): review screen, routing, cleanup flow,
server/safety/perf. Every item below was reproduced by a QA agent; the ones marked (x2) by two
independently. Hold-specific findings (expiry not reported to the page, undo racing the worker) are
requirements of trash.md, which replaces the holding folder.

## A. Route guards wait for the data (x2)

`beforeLoad` guards read the DB collections synchronously before the stream has hydrated them, so
on a cold load or reload:
- `/cleanup/$section/confirm` redirects away and the dialog never reopens (x2);
- `/cleanup/<unknown>` renders the first section instead of not-found;
- `/cleanup` never redirects to the first section, so the URL doesn't describe the view (x2).
Fix: guards and loaders wait for the collections they read to be ready (the collections' own
readiness: preload / `toArrayWhenReady` / the scan's first-sections or done state) inside the
loader, with `pendingComponent`. Then decide. Re-check when the scan finishes, in the router's
terms (invalidate on the scan-done transition from the data layer), not with an effect. A junk
child under a valid section (`/cleanup/caches/bogus`) is the router's not-found, not "no section
called caches".

## B. Big selections must work end to end (x2)

- **Approve:** the page posts every selected path to `/preview` and `/decide`. Past roughly 8 to 14k
  items the 1 MB body cap answers 413 and the selection can never be approved. Send the URL
  selection itself (`add`/`drop` tokens with section tokens) and let the server decode it against
  the run's item record with the same hash; the body stays tiny. A cap breach shows a plain error
  at the action, never a TCP reset.
- **Reload:** a URL over about 16 KB gets 431 from the 16 KB header cap, and the page can't
  reload (Firefox NET_RESET, Chromium hang). Raise the header cap for the request line to cover
  realistic selections (the server is local; 256 KB is fine), keep the other header limits, and
  answer an oversize request with a readable 431 page. Test with a 5,000-change selection.

## C. Firefox speed on the real page (x2)

On a 12k-row section, real Firefox (rAF gap sampling on the built page, not React Profiler work):
- the filter's first keystrokes: 275 to 675 ms frames;
- only-selected: 367 ms; risk toggle: 317 to 467 ms; sort: 417 to 558 ms;
- opening the section: 1.6 s;
- a rescan streaming 12k items: frames of 580 to 740 ms, up to 1.7 s while interacting.
Chromium is lower but still over 100 ms for several of these.
Targets (table.md): no frame over 50 ms while streaming, no interaction over 100 ms, in both
browsers at 10k+ rows. Profile in Firefox first; name the cost before changing anything. Move work
off the interaction path (incremental live-query updates, smaller commits, `startTransition` /
`useDeferredValue`, chunked or worker work) as the profile dictates. The perf project gains
real-browser frame tests (rAF gaps on the built page in Firefox and Chromium) for exactly these
interactions; the existing React-work tests stay.

### Outcome (measured 2026-10-04)

Firefox profile (Gecko profiler on the built page, 12,000 rows): every new filter key, sort or
only-selected value built a new TanStack DB live query whose first graph run hashed every row
(`hashObject` / `writeByte` / `isBinaryValue` in db-ivm), 140 to 340 ms per query, synchronously on
the interaction; while streaming, each typed key added another live query that every later batch
flowed through (4.2 s of graph runs in a 10 s window). The open section and per-section totals now
come from an incremental index (db.md, "QA round 2"), and at most 300 streamed events are applied
per frame.

Largest frame (ms), real binary, 12,000-row node_modules section, headless, before (858b272) /
after:

| interaction | Firefox | Chromium |
|---|---|---|
| open the section | 99 / 34 | 33 / 17 |
| filter, first keystrokes | 891 / 33 | 50 / 33 |
| only selected | 41 / 10 | 17 / 17 |
| risk toggle | 500 / 25 | 167 / 17 |
| sort by name | 358 / 33 | 133 / 17 |
| sort by size | 142 / 34 | 17 / 17 |
| rescan streaming 12k items | 41 / 42 | 17 / 17 |
| typing and toggling while it streams | 3,117 / 18 | 200 / 17 |
| end of the rescan (settled rows re-sent) | 10 / 68 | 17 / 33 |

The end-of-rescan phase in Firefox still has 3 of 830 frames over 50 ms (per-batch React render of
the chrome, about 30 ms, is the floor). The `frames` test project asserts these budgets in
Chromium and Firefox, with and without reduced motion, idle and during a real walk (section H).

## D. Never silent about the connection

After approval (waiting, cleaning, done, held, restored) a dropped stream must show
"Reconnecting…" / "Lost contact with disk-clean…" in the header. Today `BarText` returns the
done/abandoned/not-started text before it checks the link state. Undo/Free buttons are disabled
with that reason while the link is down.

## E. The movie

- Reduced motion: no film; the final numbers and a static list straight away (cleanup-movie.md).
- "time taken" uses the worker's elapsed time (it showed 17 s for a 1 s cleanup).
- The finale distinguishes "removed" (worktrees, freed) from moved-to-Trash clearly, so "items
  removed 1" next to a large held number doesn't read as a mismatch.

## F. Words and small UI

- A 409 "busy" from undo/free/empty: "Another undo or cleanup is running; this will be possible
  when it finishes", with no Retry that can't succeed (Retry only when it can).
- Anything not done ("kept", "not removed") shows its reason on the main page, not only in
  Details; a failure counts as "not removed", in red.
- The ambient free-space change is labelled so it can't read as contradicting the freed figure
  ("other apps also changed free space by …"), or moves into Details.
- Shortcut guard race: pressing a shortcut right after opening a listbox must not act (decide on
  the open state, not on the event target alone).
- Cards view: `/cleanup/$section?view=cards` expands that card; the section is visible in cards view.
- Thousands separators on every item count; "estimate"/"vm" items show their `≈` size on the
  Delete button and footer, not 0 B; a footer vs confirm difference from server rejections is
  explained in the dialog ("8 rejected, see below").
- URL hygiene: invalid values of every param are stripped consistently (`overlay=zzz`,
  `view[]=…`, well-formed tokens that match no item, whitespace-only `q`), and tab links carry no
  empty `add=&drop=`.
- Paths: `/CLEANUP` either redirects to the canonical lowercase route or is not-found; a Storage
  zoom path that doesn't exist normalizes to the nearest existing ancestor.
- With the storage map on, the header showed both "Scan failed 1m 10s" and "Scan complete": find
  out which is true and show one.

## G. Scan memory

`scan` peaked at 1.53 GB on a 7.2M-file volume. Profile where it goes (walk state, map tree,
insights) and bring the peak down so it doesn't scale linearly with file count where it doesn't
have to; report before/after on the same machine.

## Testing note (not a product change)

The scan reads the real per-user temp folders (`confstr`) and `/private/tmp` even when HOME and
TMPDIR point at a sandbox. That is correct for real use, so sandboxed tests must keep asserting
that every path in the plan is inside the sandbox before any non-dry-run step, and must never
"select all" without that filter.

## H. The scan must not starve the machine

The walk runs `available_parallelism() * 2` threads (24 on a 12-core Mac) at default priority for
the whole walk (~100 s on the user's Mac), competing with the browser that renders the page. User
report: the page janks while scanning, "could be that the scan itself is using all the CPU".
- Run every scan thread (the walk pool, worktree checks, probes, sizing) at
  `QOS_CLASS_UTILITY` via `pthread_set_qos_class_self_np` (libc, already a dependency), so macOS
  favours interactive work and schedules the scan mostly on efficiency cores. `clean` keeps its
  current priority.
- Measure, don't assume, the thread count: walk time and browser frame times during the walk with
  2x, 1x and the efficiency-core count, at utility QoS. Pick the best trade-off and record the
  numbers here.
- The real-browser frame tests from C include a run while a real walk is going (a large sandbox
  tree), in Firefox and Chromium.

### Measurements (2026-10-04, 12-core Mac: 6 performance + 6 efficiency, ~6.9M files)

Method: release `disk-clean scan "$RUN"` (read-only, temp run dir) under `/usr/bin/time -l`. 9 s
after start (past the fixed-location sizing, inside the walk), headless Firefox then headless
Chromium (Playwright 1.63) each sample 18 s on a page that runs a CSS animation and a fixed amount
of DOM work per frame (create, measure and drop rows, calibrated to ~5 ms per frame when idle).
The gap is measured with `performance.now()` between rAF callbacks. Settings ran interleaved in
three rounds. Other sessions were running browser test suites on the same machine throughout
(1-minute load average 12 to 65), so single runs are noisy; read the rows together.

Frame gaps in ms (p50 / p95 / max, and frames over 50 ms), walk wall time, max RSS:

| Setting | Load | Walk | RSS | Firefox p50/p95/max | FF >50 ms | Chromium p50/p95/max | CR >50 ms |
|---|---|---|---|---|---|---|---|
| idle, no scan | n/a | | | 11 / 24 / 178 | 12 | 16.7 / 17.3 / 18.1 | 0 |
| idle, no scan | n/a | | | 8 / 13 / 125 | 1 | 16.7 / 18.1 / 18.6 | 0 |
| baseline: 24 threads, default QoS | n/a | 94 s | 106 MB | 27 / 259 / 906 | 76 | 16.7 / 17.5 / 121.8 | 1 |
| baseline: 24 threads, default QoS | 32 | 54 s | 148 MB | 11 / 104 / 512 | 105 | 16.7 / 18.3 / 18.7 | 0 |
| baseline: 24 threads, default QoS | 31 | 62 s | 149 MB | 13 / 83 / 363 | 86 | 16.7 / 17.0 / 18.5 | 0 |
| utility, 24 threads (2x) | n/a | 122 s | 151 MB | 24 / 51 / 343 | 34 | 16.7 / 17.5 / 31.4 | 0 |
| utility, 24 threads (2x) | 38 | 75 s | 154 MB | 18 / 36 / 195 | 21 | 16.7 / 18.0 / 18.6 | 0 |
| utility, 24 threads (2x) | 39 | 155 s | 120 MB | 23 / 71 / 209 | 64 | 16.7 / 17.9 / 18.7 | 0 |
| utility, 12 threads (1x) | n/a | 111 s | 127 MB | 17 / 39 / 224 | 28 | 16.7 / 17.5 / 17.7 | 0 |
| utility, 12 threads (1x) | 35 | 110 s | 146 MB | 28 / 106 / 358 | 88 | 16.7 / 17.2 / 17.8 | 0 |
| utility, 12 threads (1x) | 66 | 145 s | 132 MB | 34 / 170 / 399 | 119 | 16.7 / 18.2 / 30.1 | 0 |
| utility, 6 threads (E cores) | n/a | 185 s | 108 MB | 15 / 38 / 275 | 30 | 16.7 / 17.4 / 17.7 | 0 |
| utility, 6 threads (E cores) | 12 | 158 s | 130 MB | 13 / 38 / 137 | 32 | 16.7 / 17.2 / 49.7 | 0 |
| utility, 6 threads (E cores) | 41 | 84 s | 117 MB | 10 / 24 / 212 | 19 | 16.7 / 17.2 / 18.4 | 0 |
| shipped: utility, E-core count (6) | 18 | 94 s | 139 MB | 10 / 45 / 1280 | 46 | 16.7 / 18.1 / 18.7 | 0 |

Walk alone (no browser open), run back to back:

| Setting | Load | Walk | user + sys CPU | RSS |
|---|---|---|---|---|
| baseline: 24 threads, default QoS | 19 | 56 s | 33 + 357 s | 157 MB |
| utility, 24 threads | 11 | 80 s | 31 + 322 s | 147 MB |
| utility, 12 threads | 19 | 77 s | 30 + 308 s | 147 MB |
| utility, 6 threads | 22 | 79 s | 28 + 228 s | 132 MB |

Reading:
- Firefox suffers from the default-QoS scan: 76 to 105 frames over 50 ms in 18 s and p95 of 83 to
  259 ms. At utility QoS the 6-thread setting was the steadiest in all three rounds (19 to 32
  frames over 50 ms, p95 24 to 38 ms). 24 threads ranged from 21 to 64, and 12 threads from 28 to
  119.
- Headless Chromium kept its frame rate in every setting, the baseline included (one 122 ms
  stall).
- At utility QoS the thread count barely changes walk time (77 to 80 s with no browser open),
  because macOS keeps utility work mostly on the efficiency cores. Fewer threads burn less kernel
  time: 228 s of sys CPU at 6 threads against 308 to 357 s at 12 or 24.
- Utility QoS costs walk time when the machine is busy: 56 to 62 s at baseline against 77 to 94 s
  at utility with similar background load. That is the intended trade: the scan yields to
  interactive work instead of competing with it.

Decision: every scan thread runs at `QOS_CLASS_UTILITY`, and the walk uses one read-ahead thread
per efficiency core (`hw.perflevel1.logicalcpu`, 6 here). On Macs without that sysctl it falls
back to half the logical cores, at least 2. That setting gave the best frame times, the same walk
time as 12 or 24 utility threads, and the least CPU.

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

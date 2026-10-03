# disk-clean: cleanup movie beat sheet

Companion to `cleanup-movie.md`. Every beat below names its motion term exactly as the
`animation-vocabulary` glossary spells it, what is on screen, its duration and GSAP ease, its
stagger, the event that triggers it, how it batches, its reduced-motion form and its performance
notes. Reviewed before any code is written.

## Ground rules

- **One master timeline** (`gsap.timeline({paused: true})`, created inside `useGSAP` so it is
  reverted on unmount). Beats are appended back to back at `tl.duration()`, never at wall-clock
  time, so the timeline holds no idle gaps and Replay plays the cleanup without the waits.
  When the playhead reaches the end and nothing is pending, the timeline pauses; appending a beat
  calls `tl.play()`.
- **Scheduler, not per-event tweens.** Events land in a pending queue. The scheduler runs when the
  timeline is idle or when the playing beat reaches its end (a `tl.call` at each beat's tail). It
  takes everything pending and picks one beat shape by queue depth (see Batching). Because pending
  events wait for at most one playing beat, the film's lag behind the worker is bounded by the
  longest beat, 1.4 s, inside the 2 s budget.
- **Gauges ride with beats.** The reclaimed counter, section rings and disk bar are tweened inside
  the beat that carries their events (same position parameter), so gauges and cards never drift
  apart and Replay reproduces them.
- **Tokens, not new numbers.** Durations come from `transitions.css` (`--duration-fast` 250 ms,
  `--duration-medium` 350 ms, `--duration-slow` 400 ms, `--duration-very-slow` 500 ms,
  `--stagger-stagger` 40 ms, `--gather-dur` 1600 ms, `--film-fade-dur` 1000 ms), read once with
  `cssMs`. The two token curves are registered with `CustomEase` (free) from the CSS values:
  `smooth-out` = `--ease-smooth-out` (0.22, 1, 0.36, 1) and `pop` = `--ease-bounce`
  (0.34, 1.36, 0.64, 1). Other eases are GSAP built-ins: `power3.inOut` for anything moving across
  the screen, `power3.out` for number tickers, `none` for constant motion.
- **Properties.** `transform` (x, y, scale, rotation via GSAP's transform props, which write one
  `transform`), `opacity`, `filter: blur()` capped at 3 px and only on one-shot entrances. Two
  deliberate exceptions on small isolated SVG elements: DrawSVG on section rings and check/lock
  icons (stroke dash = paint on 24 px elements), and the counter's text node (tabular numbers in a
  fixed-width `contain: layout paint` box). No width/height/top/left animation anywhere; bars resize
  with `scaleX` from `transformOrigin: 'left center'`.
- **Reduced motion** is a separate branch via `gsap.matchMedia()` on
  `(prefers-reduced-motion: reduce)`: no timeline, no film, no canvases. A static live list
  (one row per event, status and reason in text) under plain numbers that update in place, then
  the final numbers. Each beat's reduced-motion column below says what that list row or number
  shows.
- **Connection lost after `done`** never touches the finale. Before `done`, EventSource reconnects
  and replays; beats are keyed by path, so a replayed `removed` that already has a beat is dropped.

## What we keep from the Approved screen

| Piece | Verdict | Why |
| --- | --- | --- |
| Burning Film (WebGL backdrop) | **Keep**, as the ambient backdrop for Approve through Deleting | It is literally the story (the disk being burned clean), it is already cold grey-blue to match the page, already pauses when hidden or offscreen (`useCanvasRenderer`). It needs one prop, `running`: false draws the existing `still()` frame, which is how the finale stops the GPU loop instead of unmounting to a black screen. |
| ParticleText | **Keep, moved to the Finale** ("You freed X" figure) | A gather is a payoff moment, not a transition: in Approve the number must travel from the summary (Flip) and a particle burst there would break spatial consistency. Its render loop never ends while not reduced (`particle-text.tsx` reschedules rAF after the gather), so the finale crossfades it to identical DOM text when the gather completes and unmounts it. The vendored file stays untouched. |
| Shredder | **Keep, for headline items only** | It is the best "this is gone" image we have, but it rasterizes each item through an SVG foreignObject and runs its own physics loop, so it cannot carry hundreds of items. It shreds the six largest approved items, one instance per item (`items=[thatItem]`, `autoAnimate` when its `removed` arrives), keyed and unmounted when the beat ends. Its loop already stops itself when no strip is moving. |
| ShredQueue / Approved / `t-stagger--after-gather` timing | **Drop** | Replaced by the film's own acts; "queued for deletion" copy is replaced by the Waiting beat. |
| Fuse Button | **Keep unchanged** | Act 1 starts where its fuse ends. |

## Batching

The scheduler classifies what is pending each time it runs. `n` is the number of pending
`removed` + `worktree removed` events; `failed`, `worktree kept` and `command` events are never
folded into a count.

| Mode | When | Beat shape | Beat length |
| --- | --- | --- | --- |
| Single | n = 1 | One card (or a Shredder beat if it is a headline item) | 1.0 s card, 1.4 s shred |
| Stack | 2 to 12 | Up to 6 cards enter as a stack, leave into their rings; a "+k more" chip for the rest | 1.0 s |
| Flood | n > 12, or the tab just became visible again | No cards: rings, counter and disk bar jump in one tween; a "×n removed" chip | 0.6 s |

- Headline items degrade to a card in Stack and to the count in Flood (their shred is skipped,
  never queued behind the worker).
- `failed` and `worktree kept` in the same batch get their own beat right after the removal beat
  (Problem beats, D4/D5); several of them in one batch share one beat with a 40 ms stagger.
- `free` samples coalesce: only the latest pending sample is used, tweened inside whatever beat is
  scheduled. If no beat is scheduled within 500 ms of a sample, it gets its own gauge-only beat.
- Events already in the log when the film opens (opened after or mid cleanup, or on Replay) are
  the backlog. It plays back in batches of the worker's own timing: each batch takes the events
  within 1 s of `elapsed_ms` of its first event, so a backlog plays as the Single / Stack / Flood
  beats it would have had live, not as one catch-up Flood. Events arriving after the film opened
  follow the live rule above.
- While `document.hidden`, the scheduler does not build beats (rAF is stopped, so GSAP is frozen);
  events keep updating the data. On `visibilitychange` to visible, everything pending becomes one
  Flood beat.

## Act 1: Approve

Trigger: the fuse ends and `/decide approve` resolves (the page's own `approve`, no SSE event).
The review UI stays mounted until A2 finishes (today `App` swaps to `<Approved>` at once; it must
render both for 400 ms).

| # | Beat (term) | On screen | Duration / ease | Stagger | Reduced motion | Performance |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | **Hold to confirm** (existing fuse) | Fuse burns along the Approve button, label "Undo" | 4000 ms linear, WAAPI in `fuse-button.tsx`, unchanged | none | Existing static "Undo (3s)" countdown | Already one WAAPI animation; untouched |
| A2 | **Exit** of the review UI, **Origin-aware animation** toward the summary number | Header, tabs content and action bar fade out and shrink toward the big number: `opacity 0`, `scale 0.96`, `blur 3px`, `transformOrigin` at the number's centre | 400 ms (`--duration-slow`), `smooth-out` | 40 ms: action bar, content, header (closest to the user's click first) | Instant swap to the static list view | Three large layers: transform/opacity, `will-change` set for 400 ms then cleared; blur only here, 3 px, one shot |
| A3 | **Shared element transition** (GSAP Flip) | The approved total travels from the summary slot to centre stage and grows to 96 px | 600 ms, `power3.inOut` | none | Number shown centred, no travel | `Flip.getState` on the summary number before the swap, `Flip.from` with `scale: true` on the hero (matching `data-flip-id`): one measure, then transform only |
| A4 | **Fade in** (Burning Film) | Film rises behind the number to `--film-opacity` 0.8 | 1000 ms (`--film-fade-dur`), `power1.out`, starts with A2 | none | No film (static dark background) | Only continuous GPU loop of Acts 1 to 3; pauses when hidden/offscreen (existing) |
| A5 | **Fade in** + **Translate** of the caption | Under the number: "approved for deletion", then the item and section counts | 500 ms (`--stagger-dur`), `smooth-out`, y 12 px to 0, blur 3 px to 0 | 40 ms between lines (SplitText `lines`) | Text shown | SplitText into lines once; transform/opacity; reverted by `useGSAP` |

## Act 2: Waiting

Trigger: `waiting` (worker events file not there yet; Claude is showing the dry run). Skipped if
`started` arrives before A5 ends. Replay holds this act for 1.5 s at the label `waiting`.

| # | Beat (term) | On screen | Duration / ease | Stagger | Reduced motion | Performance |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | **Pulse** (`t-pulse`) | "Waiting for the deletion to start" breathes between full and 45 % opacity, under the approved total; no counter, no bar, nothing that looks like progress | 2000 ms (`--shimmer-dur`) `ease-in-out`, alternate, CSS | none | Plain text, no pulse | Opacity only, so it runs on the compositor. The `t-shimmer` sweep animated `background-position` under `background-clip: text`, a repaint every frame (~27 % of a core in Firefox), and any mask that softens a transform sweep also forces repaints; class removed on `started`, so it stops |
| W2 | **Idle animation** (the film itself) | Film keeps burning; nothing else moves | until `started` (watcher gives up after 30 min) | none | none | Same single loop as A4 |

## Act 3: Deleting

Stage layout: centre is the reclaimed counter with "of <approved> approved" beneath; a card slot
under it; a column of section rows on the left (title, 24 px ring, bytes left); the disk bar along
the bottom (used / freed / free segments); two trays on the right, "Kept" and "Not removed".

| # | Beat (term) | Trigger | On screen | Duration / ease | Stagger | Batching | Reduced motion | Performance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D0a | **Shared element transition** (Flip) | `started` | The approved total shrinks into the "of X approved" label slot; the counter appears above it at 0 B | 500 ms, `power3.inOut` | none | Once | Counter "0 B of X freed" | One Flip; counter box is fixed width |
| D0b | **Stagger** of **Fade in** + **Translate** | `started` | Section rows (from the page's own selection) and the disk bar build in | 500 ms each, `smooth-out`, y 12 px | 40 ms per row, capped so the last row starts by 400 ms | Once | List header and empty section rows | transform/opacity; rows are ≤ 20 nodes |
| D1 | **Scale in** then **Shared element transition** into the ring | `removed`, `worktree` removed | A card (label, size, section colour) scales in at the card slot (0.96 to 1, fade), holds, then travels to its section's ring shrinking to 0.3 and fading | in 250 ms `smooth-out`, hold 300 ms, out 450 ms `power3.inOut` (1.0 s) | none | Single mode | Row appended: "Removed <label> <size>" | Pool of 8 card nodes reused, never mount per item; ring position measured once per section at D0b (no reads during the beat) |
| D1s | **Shredder** (headline, its own physics) | `removed` of one of the six largest approved items, Single mode only | That item's card feeds through the shredder slit under the counter, strips fall and fade | 1.4 s timeline slot; `tl.call` sets `autoAnimate`; the slot does not wait on `onShred` | none | Degrades to D1 card in Stack, to the count in Flood | Same row as D1 | One Shredder instance at a time, keyed, unmounted at slot end; its rAF stops by itself |
| D2 | **Stagger** of D1 cards | Stack mode | Up to 6 cards enter as a slightly offset stack, then peel off into their rings; "+k more" chip pops | 1.0 s total: in 250 ms, out 450 ms | 40 ms in, 30 ms out | Stack | Rows appended in order | Pooled nodes; no blur in this mode |
| D3 | **Number ticker** | rides every D1/D1s/D2/D6 beat | Counter climbs from its previous value to sum of removed bytes; units switch at boundaries (MB to GB) without jitter | 600 ms, `power3.out` | none | Coalesced per beat | Number updates in place, no tween | Proxy `{v}` tween, `onUpdate` writes `textContent` with `formatBytes`; tabular numbers in a contained box |
| D4 | **Line drawing** of section rings, then **Pulse** | rides D1/D2/D6 | Section ring arc extends to its removed fraction; the row's "left" bytes ticks down; ring pulses once (scale 1 to 1.06 and back) | arc 350 ms `power3.inOut`; pulse 150 ms ×2 yoyo `power1.inOut` | 40 ms across sections touched in the same beat | Coalesced per section per beat | "3/7 removed" text in the row | DrawSVG on a 24 px circle (paint, small, isolated) |
| D5 | **Continuity transition** of the disk bar (the spec's "morph") | `free` | Freed segment grows, used segment shrinks to the real statfs figure; the "free: X" label ticks | 500 ms, `power3.inOut` | none | Latest sample only; rides the next beat or its own 500 ms gauge beat | "Free: X" text | `scaleX` on segment rects, origin left; never width |
| D6 | **Flood** count | Flood mode | Card slot shows a "×n removed" chip that pops (scale 0.96 to 1), rings/counter/bar jump in parallel | 600 ms, chip `pop`, gauges `power3.out` | none | Flood | One row per item still appended (the list is the record) | No cards, no blur; one tween per touched section |
| D7 | **Shake / Wiggle**, then **Slide in** to the tray | `failed` | Card in the slot with a red edge and the reason ("still present after removal: permission denied"), shakes, then slides into "Not removed" tray where it stays readable | shake 300 ms keyframes x −6, 6, −3, 0 `none`; slide 400 ms `smooth-out` | 40 ms when several share a beat | Own beat after the batch's removal beat; never counted into Flood | Row "Not removed: <label>, <reason>" in red | transform only; tray is a fixed-size list, new rows translate in |
| D8 | **Scale in** + **Line drawing** (lock icon), then **Slide in** to the tray | `worktree` with `outcome: kept` | Card with a lock that draws itself and the reason ("uncommitted changes"), calm (no shake: keeping it was the safe outcome), then into "Kept" tray | in 250 ms `smooth-out`; lock 350 ms `power3.inOut`; slide 400 ms `smooth-out` | 40 ms | As D7 | Row "Kept: <label>, <reason>" | DrawSVG on a 16 px icon |
| D9 | **Typewriter** (SplitText chars) + **Line drawing** (status icon) | `command` | One line in a small command strip: label types in, then a check or a cross draws | chars 20 ms each, capped at 400 ms total; icon 350 ms `power3.inOut` | 20 ms per char | Commands are few; each is its own short beat (0.75 s); a failed command also goes to the "Not removed" tray | Row "Ran <label>: ok/failed" | SplitText reverted after the beat (plain text left behind) |
| D10 | **Line drawing** of a check + **Pulse** | a section's last item is accounted for | The section ring closes, a check draws inside it, row dims to 60 % | check 350 ms `power3.inOut`, pulse as D4, dim 250 ms `smooth-out` | none | Rides the beat that completed the section | "Done" in the row | DrawSVG, small |

## Act 4: Finale

Trigger: `done`. Pending events are flushed first as one Flood beat (≤ 0.6 s). The counter's last
tween targets `done.reclaimed`, which is the authoritative figure (it can differ from the sum of
planned bytes); the finale shows `reclaimed`, never the plan.

| # | Beat (term) | On screen | Duration / ease | Stagger | Reduced motion | Performance |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | **Exit** of the stage | Card slot, section rows, command strip leave: fade, y −8 px, blur 2 px. Trays stay if non-empty (they slide to the stats area in F5) | 350 ms (`--duration-medium`), `smooth-out` | 30 ms | Stage list stays; finale numbers appear above it | transform/opacity; one-shot 2 px blur |
| F2 | **Crossfade** of the film to its still frame | Film lowers to 0.45 opacity and stops burning on its final frame | 1000 ms, `power1.out`; `running` false at the end | none | none (no film) | After this no WebGL loop runs (`still()` path in `useCanvasRenderer`) |
| F3 | **Fade in** + **Translate** of "You freed" (SplitText words) | Small heading above the figure | 500 ms, `smooth-out`, y 12 px, blur 3 px | 40 ms per word | Text | SplitText words, reverted after |
| F4 | ParticleText gather, then **Crossfade** to DOM text | `formatBytes(reclaimed)` assembles from particles at 96 px, then is swapped for the same text in DOM | gather 1600 ms (`--gather-dur`) including the component's 420 ms particle stagger, so the last particle lands as the crossfade starts; both scale with the take's speed; crossfade 250 ms `smooth-out` | component's own particle stagger | Number shown | `glow` off: canvas `shadowBlur` on every particle cost 110 to 150 ms a frame in Firefox, so the particles never converged and GSAP's lag smoothing stalled the finale. DOM figure has no letter-spacing so it matches the canvas text. ParticleText canvas unmounted after the crossfade: its loop would otherwise never stop |
| F5 | **Continuity transition** before→after disk bars | Two bars: before (static), after animates from the before split to the final one; a bracket over the freed span draws itself (**Line drawing**) | bar 900 ms `power3.inOut`; bracket 350 ms `power3.inOut` after the bar | none | Two static bars with figures | `scaleX` only; bracket DrawSVG |
| F6 | **Stagger** of stats + **Number ticker** | Six tiles: items removed, sections, biggest item (label + size), time taken (`done` elapsed), kept, not removed; kept/failed tiles expand into their trays' lists on click (instant, no animation: user-driven, frequent) | tiles 500 ms `smooth-out` y 12 px; tickers 800 ms `power3.out` | 40 ms per tile | Static tiles | Six text tickers, then idle |
| F7 | **Marquee**, one pass, no loop (credits roll) | Every removed path, grouped by section, rolls upward through a masked window; ends on "and that's everything" and stops (no loop) | `y` of one list container, `none` ease, 60 px/s, clamped to 8 to 45 s (long lists roll faster); starts 300 ms after F6 | none | Full list, plain, scrollable | One translated layer; static gradient mask (not animated); user scroll or wheel on it kills the tween and leaves a normal scroll list |
| F8 | **Fade in** of Replay | "Replay" button under the stats | 250 ms (`--duration-fast`), `smooth-out` | none | Hidden (no film to replay) | Replay remounts the film (a new take keyed by a counter) and plays the whole log again at `timeScale(1.5)`. Seeking the master timeline back does not work: its tweens are `immediateRender: false` (beats are appended live), and GSAP leaves such tweens at their end values when the playhead rewinds past them, so the finale stayed on top of the stage |

**Settled** = F7 finished (or was killed by the user) and F4's crossfade done. Checks at that
point: `tl.isActive()` false, `gsap.globalTimeline.getChildren(true, true, false)` has no active
tween, no `t-pulse` element, BurningFilm `running` false, no ParticleText or Shredder canvas in
the DOM, EventSource closed. Nothing draws on an idle tab.

## Storyboard

```
ACT 1  APPROVE                                   (fuse end → ~1.1 s)
┌───────────────────────────────┐   ┌───────────────────────────────┐
│ Disk Clean   [Cleanup|Storage]│   │ ░░░░░░░░ burning film ░░░░░░░ │
│ ◔ 42.1 GB  Selected to free   │ → │                               │
│ ┌ list ───────────────────┐   │   │           42.1 GB             │
│ │ ...                     │   │   │     approved for deletion     │
│ └─────────────────────────┘   │   │   312 items in 9 sections     │
│ [Cancel][Preview][Approve▬▬▬▬]│   │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
└───────────────────────────────┘   └───────────────────────────────┘
  A1 fuse burns   A2 UI shrinks toward the number   A3 number Flips to centre

ACT 2  WAITING                                   (until `started`)
┌───────────────────────────────┐
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│           42.1 GB             │
│  Waiting for the deletion to  │   ← pulse only, no bar, no counter
│            start              │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
└───────────────────────────────┘

ACT 3  DELETING                                  (`started` … `done`)
┌───────────────────────────────────────────────────────────────┐
│ Sections            12.8 GB                        Kept       │
│ ◕ Caches     2.1G   of 42.1 GB approved            [lock] wt   │
│ ◑ node_mod   6.0G   ┌──────────────────────┐         uncomm.  │
│ ○ Xcode     14.2G   │ ~/Library/Caches/... │──╮   Not removed │
│ ✓ Trash      done   │ 1.2 GB  · Caches     │  ╰→◕ ✗ ~/x       │
│                     └──────────────────────┘        EACCES    │
│ $ brew cleanup ✓                                              │
│ disk ▕██████████████████▓▓▓▓▓░░░░░░░░▏ free 61.3 GB           │
└───────────────────────────────────────────────────────────────┘
  D1 card scales in, travels into its ring · D3 counter ticks · D4 ring arc
  D5 bar segment rescales on `free` · D7/D8 problem cards land in trays

ACT 4  FINALE                                    (`done` → settled ~6–50 s)
┌───────────────────────────────┐   ┌───────────────────────────────┐
│ ▒▒▒▒▒▒ film, still frame ▒▒▒▒ │   │   items 309  sections 9       │
│           You freed           │   │   biggest  Xcode DerivedData  │
│           41.7 GB             │ → │   time 2m 14s  kept 2  ✗ 1    │
│ before ▕████████████░░░░▏     │   │  ┌ credits ────────────────┐  │
│ after  ▕███████░░░░░░░░░▏     │   │  │ ~/Library/Caches/pip    │↑ │
│              └─41.7 GB─┘      │   │  │ ~/src/a/node_modules    │  │
│                               │   │  └─────────────────────────┘  │
│                               │   │           [Replay]            │
└───────────────────────────────┘   └───────────────────────────────┘
  F3–F5 heading, particle figure, before→after   F6 stats · F7 credits once · F8 Replay
```

## Build notes for phase 2

- Dependencies: `gsap` and `@gsap/react`; plugins registered once: `Flip`, `SplitText`,
  `DrawSVGPlugin`, `CustomEase` (MorphSVG is not needed: the bar change is a rectangle rescale).
- The film view owns the event queue and the scheduler; components below it only receive refs.
  All tweens are created through `useGSAP`'s `contextSafe` so unmount reverts them.
- The browser tests in the spec stay valid: the counter's final value is set by the last tween to
  `done.reclaimed`, and the reduced-motion branch renders the static list, so tests can assert on
  it without waiting for motion.

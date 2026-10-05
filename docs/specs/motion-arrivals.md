# disk-clean: data arrives with motion, never pops

Decided 2026-10-04 (user: "stuff just pops into view... it should transition in and out nicely,
use the transitions.dev skills"). The page streams: sections, rows, totals and statuses appear,
change and disappear while the user watches. Every one of those changes gets a deliberate
transition from the user's transitions.dev skills, applied with their tokens.

## Skills to load first (implementing agent)

- `transitions-dev`: the catalog and its reference files; snippets are pasted verbatim with their
  `t-*` hooks and reduced-motion blocks.
- `transitions-polish`: the motion-token scale (durations, easings, distances, scales, blur) and the
  open/close asymmetry, stagger and delay rules.
- `animation-vocabulary`, `fixing-motion-performance` and `review-animations`: the final self-review
  pass, whose findings table goes in the report.

## Every moment and its transition

| moment | transition (transitions.dev) | notes |
| --- | --- | --- |
| page first paint while scanning | **Skeleton loader and reveal** (14) | skeleton rows/cards/sidebar pulse, then cross-fade + cross-blur to real content per region as it arrives |
| a new section appears in the sidebar / cards grid | **Texts reveal** (18) stagger for the entry, **Card resize** (01) for the list height | `--duration-stagger` 40 ms per item, total stagger capped at ~300 ms per batch |
| sections reorder as sizes grow | position change with `--ease-smooth-out`, FLIP (transform only) | never animate width/height/top; one FLIP per frame batch |
| new rows arrive in the open section | rows newly inserted in view: fade + 4–8 px rise + `--blur-small`, staggered within a batch | only rows that are NEW data, never rows the virtualizer mounts on scroll; rows inserted off-screen don't animate |
| a row leaves (rescan drop, unlisted, moved to Trash) | exit: fade + slight collapse, faster than enter (close asymmetry) | the list closes the gap with Card resize, not a jump |
| every changing number (totals, sizes, counts, Delete button, footer, summary, sidebar sizes) | **Number pop-in** (02) or **Spinning counter** (26) for the hero only | digits re-enter; no layout shift (tabular nums) |
| status text changes (Scanning… / Checking 1 worktree / Scan complete / Delete reasons / header bar) | **Text states swap** (04) | 150 ms, symmetric |
| scanning / "checking…" rows | **Shimmer text** (15) or **Matrix dot loader** (31) | then **Icon swap** (09) / **Success check** (10) feel when the check resolves into a checkbox |
| warning banners (hidden selected, risky selected, scan problems, connection lost) | **Banner stacking** (32) | new ones rise in, older ones push back; exit fades out quickly |
| errors at an action | **Error state shake** (12) on the action + the message | once per failure |
| Delete / Free / Empty / Undo dialogs | **Modal open / close** (06) | 250 ms open, 150 ms close, scale 0.96 |
| Details sheet / progress panel | **Panel reveal** (07) | 400 ms open, 350 ms close |
| tabs, list↔cards | **Tabs sliding** (16), **Page side-by-side** (08) for the view switch | |
| tooltips | **Tooltip** (17) | 80 ms intent delay, instant out |
| toasts (restored, emptied, copied) | **Toast** (22) | |
| checkbox ticks | **Checkbox check** (25) | gentle; it is a high-frequency action, so short |
| Clear selection / Reset | the affected rows' checkboxes animate together, capped stagger | |

## Rules

- **Frequency decides intensity** (review-animations): streaming rows and ticks are frequent, so
  they get short, subtle motion; first paint, the dialogs and the finale get the full treatment.
  Keyboard shortcuts never trigger decorative motion.
- **Animate only `transform`, `opacity` and `filter` (blur), on the compositor.**
  - No layout animation; height changes go through Card resize's technique.
  - No animation may push a frame past 50 ms or an interaction past 100 ms: the real-browser frame
    tests from qa-round-2.md run with motion on, in Firefox and Chromium at 10k+ rows.
- **Streaming bursts batch:** at most one enter animation per frame batch. Above a threshold (for
  example more than ~40 new rows in view at once) rows appear with a single group fade instead of
  per-row stagger.
- **Interruptible:** a row that leaves while still entering reverses from its current state (CSS
  transitions, not restarting keyframes).
- **Reduced motion:** keep the opacity cross-fades and drop the movement, blur and stagger
  (transitions-dev's guards); shimmer and loaders become static text.
- **Tokens:** values come from the transitions.dev motion tokens (`_root.css`), not ad-hoc ms or
  cubic-beziers.
- **No effects:** enter/exit is driven by CSS (`@starting-style`, `transition-behavior:
  allow-discrete`, `onTransitionEnd`/`onAnimationEnd`), `key`s and `useGSAP` where GSAP is already
  used. Never `useEffect`, and never data-keyed ref callbacks (no-effects.md).

## Tests

Browser (Chromium + Firefox):
- streamed rows and sections get the enter state, and scrolled-in rows do not (assert on the
  hook attribute or class, not on CSS values);
- a row removed mid-enter ends removed;
- reduced motion disables movement;
- numbers update without layout shift (the element's box is unchanged).

The real-browser frame tests run with motion on and stay within budget.

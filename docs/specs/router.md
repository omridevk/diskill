# disk-clean: TanStack Router, everything in the URL

Decided 2026-10-03 (user: "start using tanstack router and use proper navigation, with proper file
system routing; every modal and every interaction like filtering must be in the URL"; "no need
tanstack start, we don't have a backend").

## Stack

`@tanstack/react-router` + `@tanstack/router-plugin` (Vite, file-based routes under
`web/src/routes/`, generated `routeTree.gen.ts`). No TanStack Start, no SSR, still one single-file
page served by the Rust binary. Browser history (real paths, not hash). Before coding, load the
router skills: `pnpm dlx @tanstack/intent@latest list`, then `load @tanstack/router-core#...` for
search params and file-based routing, and follow them. No zod (no new non-TanStack deps):
`validateSearch` is a plain function that never throws and falls back to defaults for any bad
value.

## Rules (from the user's router conventions)

- Which-page state lives in the PATH (nested routes, `$param`, splat `$`); search params only for
  state layered on one view (filters, sort, toggles).
- Route files use route-scoped APIs (`Route.useSearch()`, `Route.useParams()`,
  `Route.useNavigate()`, `getRouteApi`); shared components use `useSearch({strict: false})`.
- Search params declared on the shallowest route whose layout reads them; defaults stripped from
  the URL (`stripSearchParams`) so a default view has a clean URL.
- Every interaction that changes what you see updates the URL (replace for typing in the search
  box and drag-like changes, push for discrete navigation), so reload and back/forward restore it.

## Routes

| path | what |
| --- | --- |
| `/` | redirects to `/cleanup` |
| `/cleanup` | Cleanup tab; redirects to the first section (`/cleanup/$section`), so the open section is always in the path; search: `view` (list/cards), `q`, `risk[]`, `minSize`, `minAge`, `sort`, `only` (selected) |
| `/cleanup/$section` | List view with that section open (Cards: that card expanded) |
| `/cleanup/$section/confirm` | the Delete confirm modal over that section's list (hold-and-confirm spec); closing navigates back to `/cleanup/$section` with its search intact |
| `/cleanup/$section/free` | the "Free the space now?" confirm over that section; only while something is held, otherwise redirects to `/cleanup/$section` |
| `/storage` and `/storage/$` | Storage tab; the splat is the zoomed folder path; search: `shape` (sunburst/treemap) |
| `/insights` | Insights tab |
| any route, search `overlay=progress` | the cleanup progress panel (it layers over whichever tab is open); its log filter `log` (all/removed/problems/commands) |
| any route, search `overlay=movie` | the movie overlay; Replay is `navigate` with a fresh `take` key |

### Routes own their UI (added 2026-10-04)

The first cut left most route files as empty markers (`createFileRoute(...)({})`) while `Shell`
decided what to render with `useMatch`, fetched the confirm plan in a `useEffect`, and passed data
down through a React context. That is routing done by hand next to the router. The rule:

- Every route file renders what its URL means. `cleanup.confirm.tsx` renders the confirm dialog
  (layered over the list through the parent's `<Outlet />`), `cleanup.free.tsx` the Free dialog,
  `cleanup.$section.tsx` the open section (reading `Route.useParams()`), `storage.$.tsx` the zoomed
  folder. No `useMatch` / `useChildMatches` to decide what to show; no `useParams({strict: false})`
  inside route-owned UI.
- Route work lives in the route: the confirm plan is fetched by the `/cleanup/$section/confirm` loader
  (`Route.useLoaderData()`, pending UI via `pendingComponent`), `/cleanup/$section/free` redirects in
  `beforeLoad` when nothing is held, an unknown `$section` is `notFound()`.
- Data reaches route components through the data layer's own hooks (TanStack DB live queries,
  db.md), not through a Shell-level React context. `Shell` keeps only the chrome that is on every
  route (header, summary, tabs as `<Link>`s, footer).
- A dialog never changes what is behind it: the dialog routes are children of the view they cover
  (`$section/confirm`), and every search param of that view survives opening and closing them.
- Switching tabs returns to where you were in that tab (its last URL in this session, kept in the
  tab links); the current view is always fully described by the URL.
- Paths are shown from the home folder the server reports (`~`), never inferred from the storage map,
  which may be skipped.
- Overlays that layer over any route (`overlay=progress|movie`) stay search params read by one
  root-level component.

Hover, tooltips and in-flight animation state stay out of the URL. Selection (which items are
ticked) lives in the URL as the user's changes against the recommended preselection: root search
params `add` and `drop`, each a `.`-joined list of tokens, declared on the root route (every tab
reads the selection), retained across navigation, defaults stripped. An item token is the first 8
base-36 characters of a 53-bit hash of its path (the full 11 when two items in the scan share the
short form); a whole-section toggle is one `_<section id>` token, and the encoder picks, per
section, whichever of "no section token", "section on" or "section off" needs the fewest tokens.
Unknown or malformed tokens are dropped by `validateSearch`. Ticking replaces the history entry, so
Back never steps through individual ticks. TanStack Table row selection stays the table's state,
fed from the URL. After approval the server's approved-page data still restores the exact
approved list on reload.

## Server

`review` and `watch` serve the page for every `GET` path that is not `/events` or a POST route
(SPA fallback), keeping the token in the page as today and the Host/Origin checks from the
hardening spec. Unknown deep links render the app's not-found route.

## Tests

Browser: each route renders from a cold load (deep link) and after reload; back/forward across tab,
section, zoom and modal changes; filters round-trip through the URL; invalid search values fall
back to defaults without errors; the confirm modal and overlays open from the URL and close with
Escape back to the previous URL. Rust: deep-link GETs return the page, `/events` and POST routes
unchanged.

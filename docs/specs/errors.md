# disk-clean: errors, loading and server calls

Decided 2026-10-04. Seen: on the Vite dev server (no backend) `POST /preview` failed and the confirm
dialog spun on "Checking the selection…" forever, with nothing on screen. Errors are swallowed or
turned into ad hoc `error` strings in many places. The stack already has the tools; use them.

## Rules

- **Every server call goes through TanStack Query** (`@tanstack/react-query`, pre-approved):
  - reads: `/preview`, the approved-page data;
  - writes: `/decide`, `/rescan`, `/undo`, `/free`.
  - One `QueryClient` lives in the router context. No bare `fetch().then().catch(setError)` and no
    hand-rolled `busy`/`error` state.
  - One `post()` in `lib/api.ts` turns non-2xx responses into typed errors (status plus the
    server's text) and network failures into a "can't reach disk-clean" error.
- **Route data uses loaders plus Query:** `loader: ({context}) => context.queryClient.ensureQueryData(...)`,
  and the component reads it with `useSuspenseQuery`.
  - Every route with a loader has a `pendingComponent` and an `errorComponent`. The error component
    shows what failed, in plain words, with a Retry that calls `router.invalidate()` / the query's
    `refetch`.
  - The root route has an `errorComponent` and a `notFoundComponent`, so nothing can white-screen.
- **Suspense and error boundaries:** components that read suspending data are wrapped in Suspense
  plus an error boundary through the router (route `pendingComponent`/`errorComponent`) or the Query
  `QueryErrorResetBoundary` pattern. Errors are never logged and forgotten.
- **Mutations:** Approve, Cancel, Undo, Free and Rescan are mutations.
  - On the TanStack DB collections (db.md) they are optimistic actions whose failure rolls back and
    surfaces the error where the action was taken: the dialog stays open with the error and Retry,
    or the footer action shows it.
  - Buttons show pending state from `mutation.isPending`, not local `useState`.
- **Streams:** EventSource drops and server-sent `error` events are state in the DB layer, shown in
  the header ("Reconnecting…", "Lost contact with disk-clean: the cleanup keeps running; reload
  to reconnect"). They are not silent.
- **Forms:** TanStack Form for any real form. Today the page has no submit-style form: search and
  filters are URL state (router.md) and the dialogs are confirmations. If a form appears, it uses
  TanStack Form. Don't wrap URL-driven filters in a form.
- **No effects** (no-effects.md): data loading and error recovery never go through `useEffect`.

## Tests

Browser tests, Chromium and Firefox, with the fake server returning failures:
- `/preview` 500 and network failure show the confirm route's error component with Retry, and Retry
  succeeds once the server recovers;
- `/decide`, `/undo`, `/free` and `/rescan` failures roll back and show the error at the action;
- a thrown render error in a tab shows the root error component, not a blank page;
- the stream dropping shows the reconnecting state, and recovery clears it;
- pending states appear while requests are in flight (no infinite spinner: a request that never
  answers shows the pending UI plus a way out, Cancel or Escape).

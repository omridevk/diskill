# disk-clean: errors, loading and server calls

Decided 2026-10-04. Seen: on the Vite dev server (no backend) `POST /preview` failed and the confirm
dialog spun on "Checking the selection…" forever, with nothing on screen. Errors are swallowed or
turned into ad hoc `error` strings in many places. The stack already has the tools; use them.

## Rules

- **Server data goes through TanStack DB, with TanStack Query only as its engine.** The app never
  calls `useQuery`/`useMutation` directly; it uses collections and live queries (db.md).
  - Request/response data (the approved-page data and anything else fetched rather than streamed)
    are `@tanstack/query-db-collection` collections (`queryCollectionOptions`, one `QueryClient`
    created for them).
  - The live streams stay custom-sync collections.
  - One `post()` in `lib/api.ts` turns non-2xx responses into typed errors (status plus the
    server's text) and network failures into a "can't reach disk-clean" error. Every request
    goes through it.
- **Route data uses loaders.**
  - The `/cleanup/confirm` loader fetches the preview for the current selection. Once the DB
    layer lands, it is a query collection keyed by the selection, preloaded in the loader and read
    with `useLiveSuspenseQuery`.
  - Every route with a loader has a `pendingComponent` and an `errorComponent`. The error component
    shows what failed, in plain words, with a Retry that calls `router.invalidate()`.
  - The root route has an `errorComponent` and a `notFoundComponent`, so nothing can white-screen.
- **Suspense and error boundaries:** components that read suspending data are wrapped in Suspense
  plus an error boundary through the router (route `pendingComponent`/`errorComponent`) or the route error boundary. Errors are never logged and forgotten.
- **Mutations:** Approve, Cancel, Undo, Free and Rescan are TanStack DB mutations (`createOptimisticAction` or collection handlers).
  - On the TanStack DB collections (db.md) they are optimistic actions whose failure rolls back and
    surfaces the error where the action was taken: the dialog stays open with the error and Retry,
    or the footer action shows it.
  - Buttons show pending state from the transaction's state, not local `useState`.
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

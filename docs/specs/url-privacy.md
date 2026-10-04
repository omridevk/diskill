# disk-clean: no folder names in the address

Decided 2026-10-04 (user: "base64 encode all the stuff, use TanStack for this, so our URL doesn't
contain any of the folders on my machine; I don't want it to leak in browser history, like the
TypeScript playground does").

## What leaks today

- `/storage/<folder path>`: the zoomed folder is a real path (`/storage/Users/<name>/Library/...`).
- `?q=`: the filter text is often a folder or project name.
- Everything else is already safe: section ids are generic (`caches`, `node_modules`), and the
  selection (`add`/`drop`) is short hashes of paths, never paths.

## The design

1. **No path in the path.** The Storage zoom becomes a token, the same kind as the selection: the
   8-character cyrb53 base-36 hash of the folder's path (11 characters when two folders share the
   short hash), resolved against the scan's tree (`/storage/$folder`). A token that matches no
   folder normalizes to the nearest existing ancestor as today, or to the top. Breadcrumbs, the
   Storage tab memory and Back/Forward keep working.
2. **Every search value is encoded, the TanStack way.** The router gets
   `parseSearch: parseSearchWith(...)` and `stringifySearch: stringifySearchWith(...)` from
   `@tanstack/react-router` (the documented custom search serialization), encoding each value as
   base64url of its JSON (UTF-8 safe, no `+`, `/` or `=`). `validateSearch` keeps receiving plain
   values, so schemas, defaults, `stripSearchParams` and `retainSearchParams` stay as they are.
   Undecodable values fall back to their defaults and never throw (the validators already
   `.catch`).
3. **Readable keys, opaque values.** Keys stay plain (`?q=…&view=…`) so the router's middlewares
   work; only values are encoded. Defaults are still left out, so a fresh page has a clean
   address.
4. **The server needs nothing new.** It already answers every page address with the same page.
   The selection sent to `/preview` and `/decide` is the decoded `add`/`drop` token string, not the
   encoded URL value.

Be clear in the code and the docs that this is obscuring, not secrecy: base64 is reversible. It
keeps folder names out of history lists, address-bar suggestions and shared screenshots, which is
what was asked. No compression library (the TypeScript playground uses lz-string): our values are
short. Adding one needs the user's approval.

## Tests

- **Browser (Chromium and Firefox):**
  - With a sandbox HOME, no address the app produces contains the HOME path, any folder name from
    the scan or the filter text. Walk every surface: Cleanup filters, Storage zoom and breadcrumbs,
    Insights, the confirm dialog, overlays, tab switches, Back/Forward and reload.
  - Reload, Back/Forward and a pasted link restore every state, with selection, filters and zoom
    included.
  - Old-style plain addresses (`?q=cache`, `/storage/Users/...`) don't crash. They either load
    with defaults or are read and rewritten, whichever is simpler.
- **Rust:** nothing changes on the server side.

## Outcome (2026-10-04)

- **Search values.** `lib/search.ts` holds `obscureSearchValue` / `revealSearchValue` (base64url of
  the value's UTF-8 JSON, no padding) and the router's `parseSearch: parseSearchWith(revealSearchValue)`
  and `stringifySearch: stringifySearchWith(obscureSearchValue, ...)`, passed to `createRouter` in
  `App.tsx`. The names say what it is: obscuring, not secrecy. `stringifySearchWith` hands only
  strings and objects to the serializer, so every text and list value (`q`, `risk`, `view`, `sort`,
  `overlay`, `log`, `shape`, `add`, `drop`) is encoded, while numbers and booleans (`take`,
  `minSize`, `minAge`, `only=true`) stay as the router writes them. They are bucket sizes, counters
  and flags, never names. Encoding them too would mean replacing `stringifySearchWith`, which this
  spec asks us to use.
- **Zoom.** The route is `/_tabs/storage/$folder` (`storage.$folder.tsx`). Its `params.parse` keeps a
  well-formed token (8 or 11 base-36 characters) and turns anything else into `''`. There is no
  `params.stringify`: whether a folder gets 8 or 11 characters depends on the whole scan tree. The
  folders live in TanStack DB: a `folders` collection (key = token, fields `path` and `parent`) is
  written in the same sync step that writes the scan's tree (`createScanStore` seed, and
  `receiveScan` when a `walked` event brings a new tree). The token rule (short when unique in the
  set, else full) is one function, `tokenFor` in `selection.ts`, shared by the selection tokens and
  the folders. The loader resolves `params.folder` with `collection.get(token)`; links read the token
  from the collection through `useFolders` (a live query) and `zoomLink`. A token the collection
  doesn't hold (a vanished folder, a non-canonical 11-character form, junk) redirects to `/storage`.
- **Old addresses.** Plain search values fail to decode, reach the validators raw, are read, and the
  canonicalizing redirect rewrites them encoded (`?q=cache` keeps its filter). A one-segment old
  zoom (`/storage/Users`) is an unknown token and lands on `/storage`; a deeper one
  (`/storage/Users/you/Library`) matches the `storage.$.tsx` splat route, whose `beforeLoad` throws
  `redirect({to: '/storage'})` with the search kept, so nothing renders.
- **Tests.** `src/url-privacy.test.tsx` (Chromium and Firefox): the codec round-trips UTF-8 with
  only `[A-Za-z0-9_-]`; walking filters, a section, a tick, the confirm dialog, Storage zoom,
  treemap and crumbs, Insights, tab switches, Back/Forward and a reload writes no folder name, home
  path or filter text into any address; the progress and movie overlays likewise; a pasted link
  restores zoom, shape and selection; another restores filter, sort and the confirm dialog; old
  plain search values and old folder paths load without errors. `router.test.tsx` now drives every
  URL through the same codec and covers the token fallbacks.

# disk-clean: the cleanup list on TanStack Table + Virtual

From the QA pass of 2026-10-03. The cleanup list is hand-rolled and renders every row; a real Mac
has a ~9,100-row temp section, where opening it took 3 s, typing 4 characters in the filter 23 s and
select-all 26 s (REV-1).

## Libraries (latest)

`@tanstack/react-table` 9.2.4 and `@tanstack/react-virtual` 3.14.13. Before writing code, load the
official skills: `pnpm dlx @tanstack/intent@latest list`, then `load` the table and virtual skills
and follow them.

Build it the shadcn way: shadcn's Data Table guide (ui.shadcn.com/docs/components/data-table) and
its Table component (`pnpm dlx shadcn@latest add table` into the existing base-nova setup) — column
definitions, a `DataTable` component, the checkbox selection column, sorting/filtering toolbar
patterns — on top of TanStack Table. Read the current guide first; if it targets TanStack Table v8,
port its patterns to the v9 API (per the intent skill) rather than pinning v8, and note the
differences in the commit.

## Design

- One table instance over all scan items: `getRowId: row => row.path`, grouping by section (the
  section rows are the group rows), sorting, global filter (search) and column filters (risk, size,
  age, only-selected), all through Table state. The hand-rolled filtering/sorting/grouping code is
  deleted.
- **Selection is Table's row selection** (controlled `rowSelection`):
  `enableRowSelection: row => !row.original.report`; section checkboxes use group-row selection
  state (all / some / none, indeterminate); shortcuts and quick-select call `toggleAllRowsSelected`,
  `setRowSelection`, `getFilteredRowModel()` etc. The only custom logic left is preselection for a
  path seen for the first time (streamed scan, rescan); a path already seen keeps the user's choice.
  `lib/selection.ts` shrinks to that rule plus the derived totals.
- **Virtualised everywhere a list can be long**: the List view table, each card's expanded list in
  Cards view, and the progress panel's log (drop the 300-row cap, CLN-6). Fixed or measured row
  heights, stable keys, overscan tuned so keyboard and screen-reader navigation still work
  (aria-rowcount/aria-rowindex).
- Fix the list bugs QA found while moving: sidebar totals and counts follow active filters (REV-6),
  natural name sort (REV-7), section bars show progress after approval (CLN-11), focus return after
  dialogs (REV-3), Approve impossible with zero selected (REV-5), footer at 1024 px (REV-4),
  double-counted nested items in totals and cards (STO-4, REV-12: a path inside another selected
  path counts once).
- Performance must be O(changed rows), not O(all rows), for typing, selection and streaming; the
  cleanup event reducer becomes append-only with memoised derived state (CLN-7, MOV-4).

## Done when

Browser tests (Chromium and Firefox) with a generated 10,000-row section: opening the section,
typing a 4-character filter, select-all and scrolling each stay under 100 ms per interaction and
under 50 ms per frame; all existing selection semantics tests pass on the new table; a 5,000-event
cleanup keeps frames under 50 ms with the panel open.

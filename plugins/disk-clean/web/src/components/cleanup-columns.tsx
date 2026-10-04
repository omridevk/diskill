import {
  columnFilteringFeature,
  columnGroupingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createGroupedRowModel,
  globalFilteringFeature,
  metaHelper,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  type ColumnFiltersState,
  type Row,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table'
import {Checkbox} from '@/components/ui/checkbox'
import {formatBytes, isExact, type Risk} from '@/lib/data'
import type {CleanupProgress, Outcome} from '@/lib/progress'
import type {Entry, Nest} from '@/lib/scan-feed'
import type {CleanupSearch, Sort} from '@/lib/search'

interface CleanupMeta {
  progress: CleanupProgress | null
  nests: readonly Nest[]
}

export const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  columnGroupingFeature,
  groupedRowModel: createGroupedRowModel(),
  rowSortingFeature,
  rowSelectionFeature,
  columnVisibilityFeature,
  tableMeta: metaHelper<CleanupMeta>(),
})

export type {Entry}

export type EntryRow = Row<typeof features, Entry>

const OUTCOME_TEXT: Record<Outcome['kind'], [string, string]> = {
  removed: ['removed', 'text-muted-foreground'],
  ran: ['ran', 'text-muted-foreground'],
  kept: ['kept', 'text-amber-300'],
  failed: ['not removed', 'text-red-300'],
  held: ['held · not freed yet', 'text-sky-300'],
  freed: ['freed', 'text-muted-foreground'],
  restored: ['restored', 'text-foreground'],
}

function pendingText(progress: CleanupProgress) {
  if (progress.cleanup.done || progress.cleanup.abandoned) return 'not run'
  return progress.cleanup.started ? 'in progress' : 'queued'
}

function ItemStatus({path, progress}: {path: string; progress: CleanupProgress}) {
  const outcome = progress.byKey.get(path)
  if (!outcome) return <span className="text-xs text-muted-foreground">{pendingText(progress)}</span>
  const [text, tone] = OUTCOME_TEXT[outcome.kind]
  return <span className={`text-xs ${tone}`}>{outcome.reason ? `${text}: ${outcome.reason}` : text}</span>
}

function shifted(event: Event | undefined) {
  return event instanceof MouseEvent || event instanceof KeyboardEvent ? event.shiftKey : false
}

export function toggleRow(row: EntryRow, checked: boolean, event?: Event) {
  row.getToggleSelectedHandler()({target: {checked}, shiftKey: shifted(event)})
}

function RowCheckbox({row, locked}: {row: EntryRow; locked: boolean}) {
  return (
    <Checkbox
      aria-label={row.original.label}
      checked={row.getIsSelected()}
      disabled={locked || !row.getCanSelect()}
      onCheckedChange={(checked, details) => toggleRow(row, checked, details.event)}
    />
  )
}

function PathCell({row, progress}: {row: EntryRow; progress: CleanupProgress | null}) {
  const item = row.original
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span data-label className="truncate font-mono text-[12.5px]">
        {item.label}
      </span>
      {item.note && <span className="truncate text-xs text-muted-foreground">{item.note}</span>}
      {progress?.plan.items.has(item.path) && <ItemStatus path={item.path} progress={progress} />}
    </span>
  )
}

function idleText(age: number | undefined) {
  if (age === undefined) return ''
  return age === 0 ? 'today' : `${age}d`
}

const helper = createColumnHelper<typeof features, Entry>()

export const columns = helper.columns([
  helper.display({
    id: 'select',
    header: () => <span className="sr-only">Selected</span>,
    cell: ({row, table}) => <RowCheckbox row={row} locked={table.options.meta?.progress != null} />,
  }),
  helper.accessor('label', {
    header: 'Path',
    cell: ({row, table}) => <PathCell row={row} progress={table.options.meta?.progress ?? null} />,
  }),
  helper.accessor(row => row.age ?? undefined, {
    id: 'age',
    header: () => <span className="block text-right">Idle</span>,
    filterFn: (row, id, min: number) => (row.getValue<number | undefined>(id) ?? -1) >= min,
    cell: ({getValue}) => {
      const age = getValue()
      return <span className={`block text-right text-xs tabular-nums ${age !== undefined && age >= 90 ? 'text-amber-300' : 'text-muted-foreground'}`}>{idleText(age)}</span>
    },
  }),
  helper.accessor('bytes', {
    header: () => <span className="block text-right">Size</span>,
    filterFn: (row, id, min: number) => row.getValue<number>(id) >= min,
    cell: ({row}) => (
      <span className="block text-right text-[13px] font-medium tabular-nums">
        {isExact(row.original) ? '' : '≈'}
        {formatBytes(row.original.bytes)}
      </span>
    ),
  }),
  helper.accessor('section', {}),
  helper.accessor('risk', {filterFn: (row, id, risks: Risk[]) => risks.includes(row.getValue<Risk>(id))}),
  helper.accessor('search', {}),
  helper.accessor('path', {id: 'selected', filterFn: (row, _id, selection: RowSelectionState) => selection[row.id] === true}),
])

export const HIDDEN_COLUMNS = {section: false, risk: false, search: false, selected: false}

export const enableRowSelection = (row: EntryRow) => !row.getIsGrouped() && !row.original.report

export const searchFilter = (row: EntryRow, id: string, q: string) => row.getValue<string>(id).includes(q.toLowerCase())

export const SORTING: Record<Sort, SortingState> = {
  'size-desc': [{id: 'bytes', desc: true}],
  'size-asc': [{id: 'bytes', desc: false}],
  'name-asc': [{id: 'label', desc: false}],
  'age-desc': [{id: 'age', desc: true}],
  'age-asc': [{id: 'age', desc: false}],
}

export function sortOf(sorting: SortingState): Sort {
  const [first] = sorting
  const found = (Object.keys(SORTING) as Sort[]).find(sort => SORTING[sort][0]?.id === first?.id && SORTING[sort][0]?.desc === first?.desc)
  return found ?? 'size-desc'
}

type Filters = Pick<CleanupSearch, 'risk' | 'minSize' | 'minAge' | 'only'>

export function filtersOf({risk, minSize, minAge, only}: Filters, selection: RowSelectionState): ColumnFiltersState {
  return [
    ...(risk.length > 0 ? [{id: 'risk', value: risk}] : []),
    ...(minSize > 0 ? [{id: 'bytes', value: minSize}] : []),
    ...(minAge >= 0 ? [{id: 'age', value: minAge}] : []),
    ...(only ? [{id: 'selected', value: selection}] : []),
  ]
}

export function listOf(filters: ColumnFiltersState): Filters {
  const value = (id: string) => filters.find(f => f.id === id)?.value
  const risk = value('risk')
  const minSize = value('bytes')
  const minAge = value('age')
  return {
    risk: Array.isArray(risk) ? risk : [],
    minSize: typeof minSize === 'number' ? minSize : 0,
    minAge: typeof minAge === 'number' ? minAge : -1,
    only: value('selected') !== undefined,
  }
}

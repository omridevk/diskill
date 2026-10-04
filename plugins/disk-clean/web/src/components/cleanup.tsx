import {Link, useNavigate} from '@tanstack/react-router'
import {functionalUpdate, useTable, type ReactTable, type RowSelectionState} from '@tanstack/react-table'
import {LayoutGrid, List, Search, TriangleAlert} from 'lucide-react'
import {createContext, use, useMemo, useRef, useState, type ReactNode, type RefObject} from 'react'
import {Badge} from '@/components/ui/badge'
import {Button, buttonVariants} from '@/components/ui/button'
import {Checkbox} from '@/components/ui/checkbox'
import {Input} from '@/components/ui/input'
import {Kbd} from '@/components/ui/kbd'
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select'
import {ToggleGroup, ToggleGroupItem} from '@/components/ui/toggle-group'
import {formatBytes, outermost, plural, RISK_LABEL, sumBytes, type Risk} from '@/lib/data'
import {useLiveQuery} from '@tanstack/react-db'
import {useDb, type Db} from '@/lib/db'
import type {CleanupProgress, Removal} from '@/lib/progress'
import type {CategoryHead, Entry as Item} from '@/lib/scan-feed'
import {MIN_AGES, MIN_SIZES, NO_FILTERS, RISKS, SORTS, type CleanupSearch, type Sort, type View} from '@/lib/search'
import {STATE_MOTION, useReveal} from '@/lib/motion'
import {useProgress, useSelection, type Selection} from '@/lib/page-data'
import {useSections, useSortedEntries} from '@/lib/views'
import {
  columns,
  enableRowSelection,
  features,
  filtersOf,
  HIDDEN_COLUMNS,
  listOf,
  searchFilter,
  sortOf,
  SORTING,
  type Entry,
  type EntryRow,
} from './cleanup-columns'
import {DataTable} from './data-table'

type CleanupTable = ReactTable<typeof features, Entry>

const GROUPS: [string, Risk][] = [
  ['Safe to delete', 'safe'],
  ['Review first', 'review'],
  ['Report only', 'report'],
]
const RISK_BADGE: Record<Risk, string> = {
  safe: 'bg-emerald-500/15 text-emerald-300',
  review: 'bg-amber-500/15 text-amber-300',
  report: 'bg-muted text-muted-foreground',
}
export const RISK_BAR: Record<Risk, string> = {safe: 'bg-blue-400', review: 'bg-amber-500', report: 'bg-zinc-600'}
const SORT_LABEL: Record<Sort, string> = {
  'size-desc': 'Largest first',
  'size-asc': 'Smallest first',
  'name-asc': 'Name',
  'age-desc': 'Oldest first',
  'age-asc': 'Newest first',
}
const QUICK_SELECT_MIN = 4

interface Section extends CategoryHead {
  count: number
  bytes: number
}

interface Group {
  category: Section
  row: EntryRow
}

interface Size {
  bytes: number
  selectable: number
}

const sizes = new WeakMap<readonly EntryRow[], Size>()

function shadowedBytes(rows: readonly EntryRow[]) {
  const nests = rows[0]?.table.options.meta?.nests ?? []
  if (nests.length === 0) return 0
  const ids = new Map(rows.map(r => [r.id, r.original.bytes]))
  const shadowed = new Set(nests.filter(n => ids.has(n.outer) && ids.has(n.inner)).map(n => n.inner))
  return [...shadowed].reduce((sum, path) => sum + (ids.get(path) ?? 0), 0)
}

function sizeOf(rows: readonly EntryRow[]) {
  const known = sizes.get(rows)
  if (known) return known
  let bytes = 0
  let selectable = 0
  for (const {original} of rows) {
    bytes += original.bytes
    if (!original.report) selectable++
  }
  const size = {bytes: bytes - shadowedBytes(rows), selectable}
  sizes.set(rows, size)
  return size
}

const bytesOf = (rows: readonly EntryRow[]) => sizeOf(rows).bytes
const selectableCount = (rows: readonly EntryRow[]) => sizeOf(rows).selectable

const picked = new WeakMap<readonly EntryRow[], {on: RowSelectionState; count: number}>()

function pickedCount(rows: readonly EntryRow[], on: RowSelectionState) {
  const known = picked.get(rows)
  if (known?.on === on) return known.count
  let count = 0
  for (const row of rows) if (on[row.id] === true) count++
  picked.set(rows, {on, count})
  return count
}

function sectionProgress(removal: Removal | undefined, total: number) {
  const done = removal?.count ?? 0
  const restored = removal?.restored ?? 0
  if (restored === 0) return `${done} of ${total} done`
  return done === 0 ? `${restored} restored` : `${done} of ${total} done · ${restored} restored`
}

function onlyRestored(removal: Removal | undefined) {
  return removal !== undefined && removal.count === 0 && removal.restored > 0
}

interface Progressed {
  progress: CleanupProgress
  removals: ReadonlyMap<string, Removal>
}

function planned(section: string, progressed: Progressed) {
  return progressed.progress.plan.sections.find(s => s.id === section)
}

function pickedLabel(group: Group, on: RowSelectionState, progressed: Progressed | null) {
  const rows = group.row.subRows
  if (group.category.risk === 'report') return `${rows.length} listed`
  if (progressed) {
    const plan = planned(group.category.id, progressed)
    return plan ? sectionProgress(progressed.removals.get(group.category.id), plan.count) : 'not approved'
  }
  return `${pickedCount(rows, on)}/${selectableCount(rows)}`
}

function SectionCheckbox({group, on, locked}: {group: Group; on: RowSelectionState; locked: boolean}) {
  const selectable = selectableCount(group.row.subRows)
  if (group.category.risk === 'report' || selectable === 0) return null
  const picked = pickedCount(group.row.subRows, on)
  const all = picked >= selectable
  return (
    <Checkbox
      aria-label={`Select all in ${group.category.title}`}
      checked={all}
      indeterminate={picked > 0 && !all}
      disabled={locked}
      onCheckedChange={() => group.row.toggleSelected(!all)}
      className="mt-0.5"
    />
  )
}

function SectionBar({group, max, progressed}: {group: Group; max: number; progressed: Progressed | null}) {
  const {category} = group
  if (!progressed) {
    return (
      <span className="h-[3px] grow overflow-hidden rounded-full bg-zinc-800">
        <span className={`block h-[3px] ${RISK_BAR[category.risk]}`} style={{width: `${Math.max(2, (bytesOf(group.row.subRows) / max) * 100)}%`}} />
      </span>
    )
  }
  const plan = planned(category.id, progressed)
  const removal = progressed.removals.get(category.id)
  const share = plan && plan.bytes > 0 ? Math.min(1, (removal?.bytes ?? 0) / plan.bytes) : 0
  return (
    <span
      role="progressbar"
      aria-label={`${category.title} done`}
      aria-valuetext={plan ? sectionProgress(removal, plan.count) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      className="h-[3px] grow overflow-hidden rounded-full bg-zinc-800"
    >
      <span
        className={`block h-[3px] origin-left transition-transform duration-(--duration-very-slow) ease-(--ease-smooth-out) motion-reduce:transition-none ${onlyRestored(removal) ? 'bg-muted-foreground' : RISK_BAR[category.risk]}`}
        style={{transform: `scaleX(${share})`}}
      />
    </span>
  )
}

const pickWhere = (rows: readonly EntryRow[], wanted: (row: EntryRow) => boolean) => (old: RowSelectionState) => {
  const next = {...old}
  for (const row of rows) {
    if (wanted(row)) next[row.id] = true
    else delete next[row.id]
  }
  return next
}

function QuickSelect({table, group}: {table: CleanupTable; group: Group}) {
  const rows = group.row.subRows
  const count = selectableCount(rows)
  if (count < QUICK_SELECT_MIN) return null
  const hasAge = rows.some(r => r.original.age !== null)
  const idle = (days: number) => () => table.setRowSelection(pickWhere(rows.filter(r => r.getCanSelect()), r => (r.original.age ?? -1) >= days))
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <span className="pr-1">Select:</span>
      <Button size="xs" variant="ghost" onClick={() => group.row.toggleSelected(true)}>
        all {count}
      </Button>
      {hasAge && (
        <Button size="xs" variant="ghost" onClick={idle(90)}>
          idle 90+ days
        </Button>
      )}
      {hasAge && (
        <Button size="xs" variant="ghost" onClick={idle(365)}>
          idle 1+ year
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={() => group.row.toggleSelected(false)}>
        none
      </Button>
    </div>
  )
}

type ChangeList = (patch: Partial<CleanupSearch>, how?: {replace: boolean}) => void

function SectionLink({section, ...props}: {section: string; className?: string; children?: ReactNode}) {
  return <Link to="/cleanup/$section" params={{section}} search={prev => ({...prev, view: 'list'})} activeOptions={{includeSearch: false}} {...props} />
}

const OPEN_SECTION = 'has-[a[data-status=active]]:border-zinc-700 has-[a[data-status=active]]:bg-zinc-900'
const DEFAULT_SECTION = '[&:not(:has(a[data-status=active]))_[data-default]]:border-zinc-700 [&:not(:has(a[data-status=active]))_[data-default]]:bg-zinc-900'

function SectionButton({group, on, first, locked, max, progressed}: {group: Group; on: RowSelectionState; first: boolean; locked: boolean; max: number; progressed: Progressed | null}) {
  const {category} = group
  const picked = pickedCount(group.row.subRows, on)
  const lit = !progressed && picked > 0
  return (
    <div data-default={first || undefined} className={`flex items-start gap-2.5 rounded-lg border p-2.5 ${STATE_MOTION} ${lit ? 'border-blue-400/35 bg-blue-400/5' : 'border-transparent'} ${OPEN_SECTION}`}>
      <SectionCheckbox group={group} on={on} locked={locked} />
      <SectionLink section={category.id} className="flex grow flex-col gap-1.5 text-left">
        <span className="flex w-full items-baseline gap-2">
          <span className="grow text-[13px] font-medium">{category.title}</span>
          <span className="text-[13px] font-semibold whitespace-nowrap tabular-nums">{formatBytes(bytesOf(group.row.subRows))}</span>
        </span>
        <span className="flex w-full items-center gap-2">
          <SectionBar group={group} max={max} progressed={progressed} />
          <span className="text-[11px] text-muted-foreground">{pickedLabel(group, on, progressed)}</span>
        </span>
      </SectionLink>
    </div>
  )
}

function ListView({groups, on, progressed, children}: {groups: Group[]; on: RowSelectionState; progressed: Progressed | null; children: ReactNode}) {
  const max = Math.max(1, ...groups.map(g => bytesOf(g.row.subRows)))
  const first = groups[0]?.category.id
  return (
    <div className="flex min-h-0 grow">
      <nav aria-label="Sections" className={`flex w-80 shrink-0 flex-col gap-3.5 overflow-auto border-r px-3 py-4 ${DEFAULT_SECTION}`}>
        {GROUPS.map(([label, risk]) => {
          const inGroup = groups.filter(g => g.category.risk === risk)
          if (inGroup.length === 0) return null
          return (
            <div key={risk} className="flex flex-col gap-1.5">
              <div className="px-1 pb-0.5 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">{label}</div>
              {inGroup.map(group => (
                <SectionButton
                  key={group.category.id}
                  group={group}
                  on={on}
                  first={group.category.id === first}
                  locked={progressed !== null}
                  max={max}
                  progressed={progressed}
                />
              ))}
            </div>
          )
        })}
      </nav>
      {children}
    </div>
  )
}

function SectionPanel({table, group, progressed}: {table: CleanupTable; group: Group; progressed: Progressed | null}) {
  const replay = useReveal(group.category.id)
  return (
    <main key={group.category.id} data-replay={replay || undefined} data-open="true" className="t-panel-slide flex min-w-0 grow flex-col">
      <div className="flex flex-col gap-2.5 border-b px-6 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">{group.category.title}</h2>
          <Badge className={RISK_BADGE[group.category.risk]}>{RISK_LABEL[group.category.risk]}</Badge>
          <span className="grow" />
          <span className="text-[13px] text-muted-foreground tabular-nums">
            {formatBytes(bytesOf(group.row.subRows))} · {group.row.subRows.length} of {group.category.count} shown
          </span>
        </div>
        <p className="text-[13px] text-muted-foreground">{group.category.desc}</p>
        {!progressed && <QuickSelect table={table} group={group} />}
      </div>
      <DataTable key={group.category.id} table={table} rows={group.row.subRows} label={group.category.title} />
    </main>
  )
}

function LearnChevron() {
  return (
    <span className="t-learn-chevron">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
        <path className="t-learn-arm t-learn-arm-top" d="M6 4L10 8" />
        <path className="t-learn-arm t-learn-arm-bot" d="M10 8L6 12" />
      </svg>
    </span>
  )
}

function SectionCard({group, on, progressed}: {group: Group; on: RowSelectionState; progressed: Progressed | null}) {
  const {category} = group
  const lit = !progressed && pickedCount(group.row.subRows, on) > 0
  return (
    <div className={`flex flex-col gap-3 rounded-xl border p-4 ${STATE_MOTION} ${lit ? 'border-blue-400/45 bg-blue-400/5' : 'bg-card'}`}>
      <div className="flex items-center gap-2.5">
        <SectionCheckbox group={group} on={on} locked={progressed !== null} />
        <span className="grow text-sm font-medium">{category.title}</span>
        <Badge className={RISK_BADGE[category.risk]}>{RISK_LABEL[category.risk]}</Badge>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{formatBytes(bytesOf(group.row.subRows))}</span>
        <span className="text-xs text-muted-foreground">{pickedLabel(group, on, progressed)}</span>
      </div>
      <p className="grow text-xs leading-relaxed text-muted-foreground">{category.desc}</p>
      <SectionLink section={category.id} className={buttonVariants({variant: 'link', size: 'xs', className: 't-learn self-start px-0'})}>
        Show items <LearnChevron />
      </SectionLink>
    </div>
  )
}

function CardsView({groups, on, progressed}: {groups: Group[]; on: RowSelectionState; progressed: Progressed | null}) {
  return (
    <div className="flex min-h-0 grow flex-col gap-5 overflow-auto px-7 py-5">
      {GROUPS.map(([label, risk]) => {
        const inGroup = groups.filter(g => g.category.risk === risk)
        if (inGroup.length === 0) return null
        return (
          <section key={risk} className="flex flex-col gap-2.5">
            <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">{label}</h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
              {inGroup.map(group => (
                <SectionCard key={group.category.id} group={group} on={on} progressed={progressed} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function FilterSelect<T extends string | number>({label, value, options, render, onChange}: {label: string; value: T; options: readonly T[]; render: (value: T) => string; onChange: (value: T) => void}) {
  return (
    <Select value={String(value)} onValueChange={v => onChange(options.find(o => String(o) === v) ?? value)}>
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{() => render(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map(option => (
          <SelectItem key={option} value={String(option)}>
            {render(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function useTyped(value: string) {
  const [typed, setTyped] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setTyped(value)
  }
  return [typed, setTyped] as const
}

function SearchBox({value, onChange, inputRef}: {value: string; onChange: (q: string) => void; inputRef: RefObject<HTMLInputElement | null>}) {
  const [typed, setTyped] = useTyped(value)
  const type = (q: string) => {
    setTyped(q)
    onChange(q)
  }
  return (
    <div className="relative w-72">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={typed}
        onChange={e => type(e.target.value)}
        onKeyDown={e => {
          if (e.key !== 'Escape') return
          type('')
          e.currentTarget.blur()
        }}
        placeholder="Filter paths…"
        aria-label="Filter paths"
        className="pr-8 pl-8"
      />
      <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
    </div>
  )
}

function Toggle({on, label, onClick}: {on: boolean; label: string; onClick: () => void}) {
  return (
    <Button size="sm" variant={on ? 'secondary' : 'outline'} aria-pressed={on} onClick={onClick}>
      {label}
    </Button>
  )
}

function setFilter(table: CleanupTable, id: string, value: unknown) {
  table.getColumn(id)?.setFilterValue(value)
}

function Toolbar({table, list, onList, searchRef}: {table: CleanupTable; list: CleanupSearch; onList: ChangeList; searchRef: RefObject<HTMLInputElement | null>}) {
  const toggleRisk = (risk: Risk) => {
    const risks = list.risk.includes(risk) ? list.risk.filter(r => r !== risk) : [...list.risk, risk]
    setFilter(table, 'risk', risks.length > 0 ? risks : undefined)
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-7 py-3">
      <SearchBox value={list.q} onChange={q => table.setGlobalFilter(q)} inputRef={searchRef} />
      {RISKS.map(risk => (
        <Toggle key={risk} on={list.risk.includes(risk)} label={RISK_LABEL[risk]} onClick={() => toggleRisk(risk)} />
      ))}
      <FilterSelect label="Minimum size" value={list.minSize} options={MIN_SIZES} render={n => (n === 0 ? 'Any size' : `≥ ${formatBytes(n)}`)} onChange={n => setFilter(table, 'bytes', n > 0 ? n : undefined)} />
      <FilterSelect label="Minimum idle time" value={list.minAge} options={MIN_AGES} render={n => (n === -1 ? 'Any age' : `Idle ${n}+ days`)} onChange={n => setFilter(table, 'age', n >= 0 ? n : undefined)} />
      <FilterSelect label="Sort" value={list.sort} options={SORTS} render={s => SORT_LABEL[s]} onChange={sort => table.setSorting(SORTING[sort])} />
      <Toggle on={list.only} label="Only selected" onClick={() => setFilter(table, 'selected', list.only ? undefined : true)} />
      <span className="grow" />
      <ToggleGroup value={[list.view]} onValueChange={v => v[0] && onList({view: v[0] as View})} variant="outline" size="sm" aria-label="View">
        <ToggleGroupItem value="list" aria-label="List view">
          <List /> List
        </ToggleGroupItem>
        <ToggleGroupItem value="cards" aria-label="Card view">
          <LayoutGrid /> Cards
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}

function Warning({children}: {children: ReactNode}) {
  return (
    <div className="flex items-center gap-2">
      <TriangleAlert className="size-3.5" />
      {children}
    </div>
  )
}

function WarningLines({hidden, risky}: {hidden: Item[]; risky: number}) {
  return (
    <div className="flex flex-col gap-1 border-b bg-amber-500/5 px-7 py-2 text-xs text-amber-200">
      {hidden.length > 0 && (
        <Warning>
          {plural(hidden.length, 'selected item is', 'selected items are')} hidden by the filters ({formatBytes(sumBytes(outermost(hidden)))}). They will still be deleted.
        </Warning>
      )}
      {risky > 0 && <Warning>{plural(risky, 'item', 'items')} marked review selected: slow or costly to rebuild.</Warning>}
    </div>
  )
}

function useHeld<T>(value: T, keep: boolean) {
  const held = useRef(value)
  if (keep) held.current = value
  return held.current
}

function Warnings({hidden, risky}: {hidden: Item[]; risky: number}) {
  const open = hidden.length > 0 || risky > 0
  const shown = useHeld({hidden, risky}, open)
  return (
    <div className="t-acc" data-open={String(open)} inert={!open}>
      <div className="t-acc-panel">
        <div className="t-acc-panel-inner">
          <WarningLines hidden={shown.hidden} risky={shown.risky} />
        </div>
      </div>
    </div>
  )
}

function shortcutsOn(actions: Record<string, () => void>) {
  return (node: HTMLElement | null) => {
    const view = node?.ownerDocument.defaultView
    if (!view) return
    const onKey = (event: KeyboardEvent) => {
      const action = actions[event.key]
      const typing = event.target instanceof Element && event.target.closest('input, select, textarea, [role="dialog"], [role="listbox"]')
      if (!action || typing || event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()
      action()
    }
    view.addEventListener('keydown', onKey)
    return () => view.removeEventListener('keydown', onKey)
  }
}

const LOCKED_KEYS = new Set(['a', 'd', 'r'])

function groupsOf(table: CleanupTable, sections: readonly Section[]): Group[] {
  const rows = new Map(table.getRowModel().rows.map(row => [String(row.groupingValue), row]))
  return GROUPS.flatMap(([, risk]) =>
    sections.filter(c => c.risk === risk).flatMap(category => {
      const row = rows.get(category.id)
      return row ? [{category, row}] : []
    }),
  )
}

function sectionsOf(heads: readonly CategoryHead[], totals: readonly {id: string; count: number; bytes: number}[]): Section[] {
  const byId = new Map(totals.map(total => [total.id, total]))
  return heads
    .flatMap(head => {
      const total = byId.get(head.id)
      return total ? [{...head, count: total.count, bytes: total.bytes}] : []
    })
    .toSorted((a, b) => b.bytes - a.bytes)
}

function useCleanupTable(data: Item[], selection: Selection, list: CleanupSearch, onList: ChangeList, progress: CleanupProgress | null) {
  const only = list.only ? selection.rowSelection : null
  const columnFilters = useMemo(() => filtersOf(list, only ?? {}), [list.risk, list.minSize, list.minAge, list.only, only])
  return useTable({
    features,
    columns,
    data,
    getRowId: row => row.path,
    manualSorting: true,
    enableRowSelection,
    globalFilterFn: searchFilter,
    getColumnCanGlobalFilter: column => column.id === 'search',
    initialState: {grouping: ['section'], columnVisibility: HIDDEN_COLUMNS},
    state: {rowSelection: selection.rowSelection, globalFilter: list.q, columnFilters, sorting: SORTING[list.sort]},
    onRowSelectionChange: selection.setRowSelection,
    onGlobalFilterChange: update => onList({q: String(functionalUpdate(update, list.q) ?? '')}, {replace: true}),
    onColumnFiltersChange: update => onList(listOf(functionalUpdate(update, columnFilters))),
    onSortingChange: update => onList({sort: sortOf(functionalUpdate(update, SORTING[list.sort]))}),
    meta: {progress, nests: selection.nests},
  })
}

function useListChange(): ChangeList {
  const navigate = useNavigate()
  return (patch, how) => navigate({to: '.', search: prev => ({...prev, ...patch}), replace: how?.replace})
}

interface ListState {
  table: CleanupTable
  groups: Group[]
  progressed: Progressed | null
}

const ListContext = createContext<ListState | null>(null)

function useSectionList(db: Db) {
  const heads = useSections(db)
  const {data: totals} = useLiveQuery(db.queries.sectionTotals)
  return useMemo(() => sectionsOf(heads, totals), [heads, totals])
}

const isFiltering = (list: CleanupSearch) => list.q !== '' || list.risk.length > 0 || list.minSize > 0 || list.minAge >= 0 || list.only

function useHidden(table: CleanupTable, list: CleanupSearch, selected: readonly Item[]) {
  const filtered = table.getFilteredRowModel().rowsById
  const filtering = isFiltering(list)
  return useMemo(() => (filtering ? selected.filter(i => !filtered[i.path]) : []), [filtering, selected, filtered])
}

function Body({groups, list, onList, progressed, on, children}: {groups: Group[]; list: CleanupSearch; onList: ChangeList; progressed: Progressed | null; on: RowSelectionState; children: ReactNode}) {
  if (groups.length === 0) {
    return (
      <div className="flex grow flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        Nothing matches these filters.
        <Button variant="outline" size="sm" onClick={() => onList(NO_FILTERS)}>
          Clear filters
        </Button>
        {children}
      </div>
    )
  }
  if (list.view === 'list') {
    return (
      <ListView groups={groups} on={on} progressed={progressed}>
        {children}
      </ListView>
    )
  }
  return (
    <>
      <CardsView groups={groups} on={on} progressed={progressed} />
      {children}
    </>
  )
}

export function Cleanup({list, children}: {list: CleanupSearch; children: ReactNode}) {
  const db = useDb()
  const selection = useSelection()
  const entries = useSortedEntries(db, list.sort)
  const {progress} = useProgress()
  const sections = useSectionList(db)
  const onList = useListChange()
  const table = useCleanupTable(entries, selection, list, onList, progress)
  const search = useRef<HTMLInputElement>(null)
  const replay = useReveal(list.view)
  const groups = groupsOf(table, sections)
  const hidden = useHidden(table, list, selection.selected)
  const on = selection.rowSelection
  const progressed = progress && {progress, removals: progress.removals}

  const shortcuts: Record<string, () => void> = {
    '/': () => search.current?.focus(),
    a: () => table.toggleAllRowsSelected(true),
    d: () => table.resetRowSelection(true),
    r: () => selection.reset(),
    v: () => onList({view: list.view === 'list' ? 'cards' : 'list'}),
  }
  const keys = shortcutsOn(progress ? Object.fromEntries(Object.entries(shortcuts).filter(([key]) => !LOCKED_KEYS.has(key))) : shortcuts)

  return (
    <ListContext value={{table, groups, progressed}}>
      <div ref={keys} className="flex min-h-0 grow flex-col">
        <Toolbar table={table} list={list} onList={onList} searchRef={search} />
        <Warnings hidden={hidden} risky={selection.risky} />
        <div key={list.view} data-replay={replay || undefined} data-open="true" className="t-panel-slide flex min-h-0 grow flex-col">
          <Body groups={groups} list={list} onList={onList} progressed={progressed} on={on}>
            {children}
          </Body>
        </div>
      </div>
    </ListContext>
  )
}

export function SectionDetail({section}: {section: string}) {
  const view = use(ListContext)
  const group = view && (view.groups.find(g => g.category.id === section) ?? view.groups[0])
  return view && group ? <SectionPanel table={view.table} group={group} progressed={view.progressed} /> : null
}

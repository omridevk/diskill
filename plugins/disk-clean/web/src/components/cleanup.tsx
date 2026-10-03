import {Link, useNavigate, useParams} from '@tanstack/react-router'
import {functionalUpdate, useTable, type ReactTable, type RowSelectionState} from '@tanstack/react-table'
import {LayoutGrid, List, Search, TriangleAlert} from 'lucide-react'
import {useEffect, useMemo, useRef, useState, type ReactNode, type RefObject} from 'react'
import {Badge} from '@/components/ui/badge'
import {Button, buttonVariants} from '@/components/ui/button'
import {Checkbox} from '@/components/ui/checkbox'
import {Input} from '@/components/ui/input'
import {Kbd} from '@/components/ui/kbd'
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select'
import {ToggleGroup, ToggleGroupItem} from '@/components/ui/toggle-group'
import type {CleanupProgress} from '@/lib/cleanup'
import {formatBytes, RISK_LABEL, type Category, type Item, type Risk} from '@/lib/data'
import {MIN_AGES, MIN_SIZES, NO_FILTERS, RISKS, SORTS, type CleanupSearch, type Sort, type View} from '@/lib/search'
import {STATE_MOTION, useReveal} from '@/lib/motion'
import {outermost, sumBytes, type Selection} from '@/lib/selection'
import {
  columns,
  enableRowSelection,
  entriesOf,
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

interface Group {
  category: Category
  row: EntryRow
}

const groupBytes = new WeakMap<readonly EntryRow[], number>()

function bytesOf(rows: readonly EntryRow[]) {
  const known = groupBytes.get(rows)
  if (known !== undefined) return known
  const bytes = sumBytes(outermost(rows.map(r => r.original)))
  groupBytes.set(rows, bytes)
  return bytes
}

const selectableCounts = new WeakMap<readonly EntryRow[], number>()

function selectableCount(rows: readonly EntryRow[]) {
  const known = selectableCounts.get(rows)
  if (known !== undefined) return known
  let count = 0
  for (const row of rows) if (row.getCanSelect()) count++
  selectableCounts.set(rows, count)
  return count
}

function pickedCount(rows: readonly EntryRow[], on: RowSelectionState) {
  let count = 0
  for (const row of rows) if (on[row.id] === true) count++
  return count
}

interface Removal {
  bytes: number
  count: number
}

const CLEARED = new Set(['removed', 'held', 'freed'])

function removalsOf(progress: CleanupProgress | null) {
  const removals = new Map<string, Removal>()
  for (const outcome of progress?.byKey.values() ?? []) {
    if (!CLEARED.has(outcome.kind)) continue
    const known = removals.get(outcome.section) ?? {bytes: 0, count: 0}
    removals.set(outcome.section, {bytes: known.bytes + outcome.bytes, count: known.count + 1})
  }
  return removals
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
    return plan ? `${progressed.removals.get(group.category.id)?.count ?? 0} of ${plan.count} done` : 'not approved'
  }
  return `${pickedCount(rows, on)}/${selectableCount(rows)}`
}

function SectionCheckbox({group, locked}: {group: Group; locked: boolean}) {
  if (group.category.risk === 'report' || selectableCount(group.row.subRows) === 0) return null
  const all = group.row.getIsAllSubRowsSelected()
  return (
    <Checkbox
      aria-label={`Select all in ${group.category.title}`}
      checked={all}
      indeterminate={group.row.getIsSomeSelected()}
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
  const share = plan && plan.bytes > 0 ? Math.min(1, (progressed.removals.get(category.id)?.bytes ?? 0) / plan.bytes) : 0
  return (
    <span
      role="progressbar"
      aria-label={`${category.title} done`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      className="h-[3px] grow overflow-hidden rounded-full bg-zinc-800"
    >
      <span
        className={`block h-[3px] origin-left transition-transform duration-(--duration-very-slow) ease-(--ease-smooth-out) motion-reduce:transition-none ${RISK_BAR[category.risk]}`}
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
  return <Link to="/cleanup/$section" params={{section}} search={prev => ({...prev, view: 'list'})} {...props} />
}

function SectionButton({group, on, active, locked, max, progressed}: {group: Group; on: RowSelectionState; active: boolean; locked: boolean; max: number; progressed: Progressed | null}) {
  const {category} = group
  const picked = pickedCount(group.row.subRows, on)
  const lit = !progressed && picked > 0
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border p-2.5 ${STATE_MOTION} ${active ? 'border-zinc-700 bg-zinc-900' : lit ? 'border-blue-400/35 bg-blue-400/5' : 'border-transparent'}`}>
      <SectionCheckbox group={group} locked={locked} />
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

function ListView({table, groups, on, active, progressed}: {table: CleanupTable; groups: Group[]; on: RowSelectionState; active: string; progressed: Progressed | null}) {
  const current = groups.find(g => g.category.id === active) ?? groups[0]
  const max = Math.max(1, ...groups.map(g => bytesOf(g.row.subRows)))
  const reveal = useReveal(current?.category.id ?? '')
  return (
    <div className="flex min-h-0 grow">
      <nav aria-label="Sections" className="flex w-80 shrink-0 flex-col gap-3.5 overflow-auto border-r px-3 py-4">
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
                  active={current?.category.id === group.category.id}
                  locked={progressed !== null}
                  max={max}
                  progressed={progressed}
                />
              ))}
            </div>
          )
        })}
      </nav>
      {current && (
        <main ref={reveal} data-open="true" className="t-panel-slide flex min-w-0 grow flex-col">
          <div className="flex flex-col gap-2.5 border-b px-6 pt-4 pb-3">
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-semibold tracking-tight">{current.category.title}</h2>
              <Badge className={RISK_BADGE[current.category.risk]}>{RISK_LABEL[current.category.risk]}</Badge>
              <span className="grow" />
              <span className="text-[13px] text-muted-foreground tabular-nums">
                {formatBytes(bytesOf(current.row.subRows))} · {current.row.subRows.length} of {current.category.items.length} shown
              </span>
            </div>
            <p className="text-[13px] text-muted-foreground">{current.category.desc}</p>
            {!progressed && <QuickSelect table={table} group={current} />}
          </div>
          <DataTable key={current.category.id} table={table} rows={current.row.subRows} label={current.category.title} />
        </main>
      )}
    </div>
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
        <SectionCheckbox group={group} locked={progressed !== null} />
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

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

function WarningLines({hidden, risky}: {hidden: Item[]; risky: Item[]}) {
  return (
    <div className="flex flex-col gap-1 border-b bg-amber-500/5 px-7 py-2 text-xs text-amber-200">
      {hidden.length > 0 && (
        <Warning>
          {plural(hidden.length, 'selected item is', 'selected items are')} hidden by the filters ({formatBytes(sumBytes(outermost(hidden)))}). They will still be deleted.
        </Warning>
      )}
      {risky.length > 0 && <Warning>{plural(risky.length, 'item', 'items')} marked review selected: slow or costly to rebuild.</Warning>}
    </div>
  )
}

function useHeld<T>(value: T, keep: boolean) {
  const held = useRef(value)
  if (keep) held.current = value
  return held.current
}

function Warnings({hidden, risky}: {hidden: Item[]; risky: Item[]}) {
  const open = hidden.length > 0 || risky.length > 0
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

function useShortcuts(actions: Record<string, () => void>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = actions[event.key]
      const typing = event.target instanceof Element && event.target.closest('input, select, textarea, [role="dialog"], [role="listbox"]')
      if (!action || typing || event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

const LOCKED_KEYS = new Set(['a', 'd', 'r'])

function groupsOf(table: CleanupTable, categories: readonly Category[]): Group[] {
  const rows = new Map(table.getRowModel().rows.map(row => [String(row.groupingValue), row]))
  return GROUPS.flatMap(([, risk]) =>
    categories.filter(c => c.risk === risk).flatMap(category => {
      const row = rows.get(category.id)
      return row ? [{category, row}] : []
    }),
  )
}

function useCleanupTable(categories: readonly Category[], selection: Selection, list: CleanupSearch, onList: ChangeList, progress: CleanupProgress | null) {
  const data = useMemo(() => entriesOf(categories), [categories])
  const only = list.only ? selection.rowSelection : null
  const columnFilters = useMemo(() => filtersOf(list, only ?? {}), [list.risk, list.minSize, list.minAge, list.only, only])
  return useTable({
    features,
    columns,
    data,
    getRowId: row => row.path,
    enableRowSelection,
    globalFilterFn: searchFilter,
    getColumnCanGlobalFilter: column => column.id === 'search',
    initialState: {grouping: ['section'], columnVisibility: HIDDEN_COLUMNS},
    state: {rowSelection: selection.rowSelection, globalFilter: list.q, columnFilters, sorting: SORTING[list.sort]},
    onRowSelectionChange: selection.setRowSelection,
    onGlobalFilterChange: update => onList({q: String(functionalUpdate(update, list.q) ?? '')}, {replace: true}),
    onColumnFiltersChange: update => onList(listOf(functionalUpdate(update, columnFilters))),
    onSortingChange: update => onList({sort: sortOf(functionalUpdate(update, SORTING[list.sort]))}),
    meta: {progress},
  })
}

function useListChange(): ChangeList {
  const navigate = useNavigate()
  return (patch, how) => navigate({to: '.', search: prev => ({...prev, ...patch}), replace: how?.replace})
}

export function Cleanup({categories, selection, list, progress}: {categories: Category[]; selection: Selection; list: CleanupSearch; progress: CleanupProgress | null}) {
  const onList = useListChange()
  const section = useParams({strict: false, select: params => params.section}) ?? ''
  const table = useCleanupTable(categories, selection, list, onList, progress)
  const search = useRef<HTMLInputElement>(null)
  const reveal = useReveal(list.view)
  const groups = groupsOf(table, categories)
  const filtered = table.getFilteredRowModel().rowsById
  const hidden = useMemo(() => selection.selected.filter(i => !filtered[i.path]), [selection.selected, filtered])
  const on = selection.rowSelection
  const removals = useMemo(() => removalsOf(progress), [progress])
  const progressed = progress && {progress, removals}

  const shortcuts: Record<string, () => void> = {
    '/': () => search.current?.focus(),
    a: () => table.toggleAllRowsSelected(true),
    d: () => table.resetRowSelection(true),
    r: () => selection.reset(),
    v: () => onList({view: list.view === 'list' ? 'cards' : 'list'}),
  }
  useShortcuts(progress ? Object.fromEntries(Object.entries(shortcuts).filter(([key]) => !LOCKED_KEYS.has(key))) : shortcuts)

  const body =
    groups.length === 0 ? (
      <div className="flex grow flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        Nothing matches these filters.
        <Button variant="outline" size="sm" onClick={() => onList(NO_FILTERS)}>
          Clear filters
        </Button>
      </div>
    ) : list.view === 'list' ? (
      <ListView table={table} groups={groups} on={on} active={section} progressed={progressed} />
    ) : (
      <CardsView groups={groups} on={on} progressed={progressed} />
    )

  return (
    <div className="flex min-h-0 grow flex-col">
      <Toolbar table={table} list={list} onList={onList} searchRef={search} />
      <Warnings hidden={hidden} risky={selection.risky} />
      <div ref={reveal} data-open="true" className="t-panel-slide flex min-h-0 grow flex-col">
        {body}
      </div>
    </div>
  )
}

import {LayoutGrid, List, Search, TriangleAlert} from 'lucide-react'
import {useEffect, useMemo, useRef, useState, type ReactNode, type RefObject} from 'react'
import {Badge} from '@/components/ui/badge'
import {Button} from '@/components/ui/button'
import {Checkbox} from '@/components/ui/checkbox'
import {Input} from '@/components/ui/input'
import {Kbd} from '@/components/ui/kbd'
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select'
import {ToggleGroup, ToggleGroupItem} from '@/components/ui/toggle-group'
import type {Outcome, CleanupProgress} from '@/lib/cleanup'
import {formatBytes, isExact, RISK_LABEL, type Category, type Item, type Risk} from '@/lib/data'
import {STATE_MOTION, useReveal} from '@/lib/motion'
import {sectionState, type Selection} from '@/lib/selection'

type View = 'list' | 'cards'
type Sort = 'size-desc' | 'size-asc' | 'name-asc' | 'age-desc' | 'age-asc'

interface Filters {
  q: string
  sort: Sort
  minBytes: number
  minAge: number
  risks: Risk[]
  onlySelected: boolean
}

const NO_FILTERS: Filters = {q: '', sort: 'size-desc', minBytes: 0, minAge: -1, risks: [], onlySelected: false}
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
const MIN_SIZES = [0, 100 << 20, 1 << 30, 5 * (1 << 30)]
const MIN_AGES = [-1, 30, 90, 365]
const RISKS: Risk[] = ['safe', 'review', 'report']
const SORTS = Object.keys(SORT_LABEL) as Sort[]

function readView(): View {
  try {
    return localStorage.getItem('disk-clean:view') === 'cards' ? 'cards' : 'list'
  } catch {
    return 'list'
  }
}

function saveView(view: View) {
  try {
    localStorage.setItem('disk-clean:view', view)
  } catch {
    return
  }
}

const CHECKS: ((filters: Filters, selection: Selection, category: Category, item: Item) => boolean)[] = [
  (f, _s, c) => f.risks.length === 0 || f.risks.includes(c.risk),
  (f, _s, _c, i) => i.bytes >= f.minBytes,
  (f, _s, _c, i) => f.minAge < 0 || (i.age ?? -1) >= f.minAge,
  (f, s, _c, i) => !f.onlySelected || s.isOn(i),
  (f, _s, c, i) => `${i.label} ${i.path} ${c.title} ${i.note}`.toLowerCase().includes(f.q.toLowerCase()),
]

function matches(filters: Filters, selection: Selection, category: Category, item: Item) {
  return CHECKS.every(check => check(filters, selection, category, item))
}

function sortItems(items: Item[], sort: Sort) {
  const by: Record<Sort, (a: Item, b: Item) => number> = {
    'size-desc': (a, b) => b.bytes - a.bytes,
    'size-asc': (a, b) => a.bytes - b.bytes,
    'name-asc': (a, b) => a.label.localeCompare(b.label),
    'age-desc': (a, b) => (b.age ?? -1) - (a.age ?? -1),
    'age-asc': (a, b) => (a.age ?? 1e9) - (b.age ?? 1e9),
  }
  return items.toSorted(by[sort])
}

function SectionCheckbox({category, selection, locked}: {category: Category; selection: Selection; locked: boolean}) {
  const state = sectionState(category, selection)
  if (category.risk === 'report' || state.items.length === 0) return null
  return (
    <Checkbox
      aria-label={`Select all in ${category.title}`}
      checked={state.all}
      indeterminate={state.some}
      disabled={locked}
      onCheckedChange={() => selection.set(state.items, !state.all)}
      className="mt-0.5"
    />
  )
}

function removedLabel(category: Category, progress: CleanupProgress) {
  const approved = category.items.filter(i => progress.plan.items.has(i.path))
  if (approved.length === 0) return 'not approved'
  const removed = approved.filter(i => progress.byKey.get(i.path)?.kind === 'removed').length
  return `${removed} of ${approved.length} removed`
}

function pickedLabel(category: Category, selection: Selection, progress: CleanupProgress | null) {
  if (category.risk === 'report') return `${category.items.length} listed`
  if (progress) return removedLabel(category, progress)
  const state = sectionState(category, selection)
  return `${state.picked}/${state.items.length}`
}

function Size({item}: {item: Item}) {
  return (
    <span className="tabular-nums">
      {isExact(item) ? '' : '≈'}
      {formatBytes(item.bytes)}
    </span>
  )
}

function QuickSelect({items, selection}: {items: Item[]; selection: Selection}) {
  const pickable = items.filter(i => !i.report)
  if (pickable.length <= 3) return null
  const hasAge = pickable.some(i => i.age !== null)
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <span className="pr-1">Select:</span>
      <Button size="xs" variant="ghost" onClick={() => selection.set(pickable, true)}>
        all {pickable.length}
      </Button>
      {hasAge && (
        <Button size="xs" variant="ghost" onClick={() => selection.set(pickable, i => (i.age ?? -1) >= 90)}>
          idle 90+ days
        </Button>
      )}
      {hasAge && (
        <Button size="xs" variant="ghost" onClick={() => selection.set(pickable, i => (i.age ?? -1) >= 365)}>
          idle 1+ year
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={() => selection.set(pickable, false)}>
        none
      </Button>
    </div>
  )
}

interface Group {
  category: Category
  items: Item[]
  bytes: number
}

const OUTCOME_TEXT: Record<Outcome['kind'], [string, string]> = {
  removed: ['removed', 'text-muted-foreground'],
  ran: ['ran', 'text-muted-foreground'],
  kept: ['kept', 'text-amber-300'],
  failed: ['not removed', 'text-red-300'],
}

function pendingText(progress: CleanupProgress) {
  if (progress.cleanup.done) return 'not run'
  return progress.cleanup.started ? 'deleting' : 'queued'
}

function ItemStatus({item, progress}: {item: Item; progress: CleanupProgress}) {
  const outcome = progress.byKey.get(item.path)
  if (!outcome) return <span className="text-xs text-muted-foreground">{pendingText(progress)}</span>
  const [text, tone] = OUTCOME_TEXT[outcome.kind]
  return <span className={`text-xs ${tone}`}>{outcome.reason ? `${text}: ${outcome.reason}` : text}</span>
}

function rowTone(item: Item, on: boolean, progress: CleanupProgress | null) {
  if (!progress) return on ? 'bg-blue-400/[0.07]' : 'hover:bg-muted/40'
  if (!progress.plan.items.has(item.path)) return 'opacity-40'
  return progress.byKey.get(item.path)?.kind === 'removed' ? 'opacity-60 [&_[data-label]]:line-through' : ''
}

function ItemTable({items, selection, section, progress}: {items: Item[]; selection: Selection; section: string; progress: CleanupProgress | null}) {
  const reveal = useReveal(section)
  return (
    <div ref={reveal} data-open="true" className="t-panel-slide grow overflow-auto px-3 py-1">
      <div className="grid grid-cols-[36px_minmax(0,1fr)_80px_96px] gap-x-3 px-3 py-2 text-[11px] tracking-wide text-muted-foreground/70 uppercase">
        <span />
        <span>Path</span>
        <span className="text-right">Idle</span>
        <span className="text-right">Size</span>
      </div>
      {items.map(item => {
        const on = selection.isOn(item)
        return (
          <label
            key={item.path}
            className={`grid grid-cols-[36px_minmax(0,1fr)_80px_96px] items-center gap-x-3 rounded-lg px-3 py-2 ${progress ? '' : 'cursor-pointer'} ${STATE_MOTION} ${rowTone(item, on, progress)}`}
          >
            <Checkbox checked={on} disabled={item.report || progress !== null} onCheckedChange={value => selection.set([item], value)} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span data-label className="truncate font-mono text-[12.5px]">
                {item.label}
              </span>
              {item.note && <span className="truncate text-xs text-muted-foreground">{item.note}</span>}
              {progress?.plan.items.has(item.path) && <ItemStatus item={item} progress={progress} />}
            </span>
            <span className={`text-right text-xs tabular-nums ${item.age !== null && item.age >= 90 ? 'text-amber-300' : 'text-muted-foreground'}`}>
              {item.age === null ? '' : item.age === 0 ? 'today' : `${item.age}d`}
            </span>
            <span className="text-right text-[13px] font-medium">
              <Size item={item} />
            </span>
          </label>
        )
      })}
    </div>
  )
}

function ListView({groups, selection, active, onActive, progress}: {groups: Group[]; selection: Selection; active: string; onActive: (id: string) => void; progress: CleanupProgress | null}) {
  const ordered = GROUPS.flatMap(([, risk]) => groups.filter(g => g.category.risk === risk))
  const current = ordered.find(g => g.category.id === active) ?? ordered[0]
  const max = Math.max(1, ...groups.map(g => g.category.bytes))
  return (
    <div className="flex min-h-0 grow">
      <nav aria-label="Sections" className="flex w-80 shrink-0 flex-col gap-3.5 overflow-auto border-r px-3 py-4">
        {GROUPS.map(([label, risk]) => {
          const inGroup = groups.filter(g => g.category.risk === risk)
          if (inGroup.length === 0) return null
          return (
            <div key={risk} className="flex flex-col gap-1.5">
              <div className="px-1 pb-0.5 text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">{label}</div>
              {inGroup.map(({category}) => {
                const state = sectionState(category, selection)
                const lit = state.picked > 0
                const isActive = current?.category.id === category.id
                return (
                  <div
                    key={category.id}
                    className={`flex items-start gap-2.5 rounded-lg border p-2.5 ${STATE_MOTION} ${isActive ? 'border-zinc-700 bg-zinc-900' : lit ? 'border-blue-400/35 bg-blue-400/5' : 'border-transparent'}`}
                  >
                    <SectionCheckbox category={category} selection={selection} locked={progress !== null} />
                    <button type="button" onClick={() => onActive(category.id)} className="flex grow flex-col gap-1.5 text-left">
                      <span className="flex w-full items-baseline gap-2">
                        <span className="grow text-[13px] font-medium">{category.title}</span>
                        <span className="text-[13px] font-semibold whitespace-nowrap tabular-nums">{formatBytes(category.bytes)}</span>
                      </span>
                      <span className="flex w-full items-center gap-2">
                        <span className="h-[3px] grow overflow-hidden rounded-full bg-zinc-800">
                          <span
                            className={`block h-[3px] ${RISK_BAR[category.risk]}`}
                            style={{width: `${Math.max(2, (category.bytes / max) * 100)}%`}}
                          />
                        </span>
                        <span className="text-[11px] text-muted-foreground">{pickedLabel(category, selection, progress)}</span>
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
          )
        })}
      </nav>
      {current && (
        <main className="flex min-w-0 grow flex-col">
          <div className="flex flex-col gap-2.5 border-b px-6 pt-4 pb-3">
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-semibold tracking-tight">{current.category.title}</h2>
              <Badge className={RISK_BADGE[current.category.risk]}>{RISK_LABEL[current.category.risk]}</Badge>
              <span className="grow" />
              <span className="text-[13px] text-muted-foreground tabular-nums">
                {formatBytes(current.bytes)} · {current.items.length} of {current.category.items.length} shown
              </span>
            </div>
            <p className="text-[13px] text-muted-foreground">{current.category.desc}</p>
            {!progress && <QuickSelect items={current.items} selection={selection} />}
          </div>
          <ItemTable items={current.items} selection={selection} section={current.category.id} progress={progress} />
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

function CardsView({groups, selection, onOpen, progress}: {groups: Group[]; selection: Selection; onOpen: (id: string) => void; progress: CleanupProgress | null}) {
  return (
    <div className="flex min-h-0 grow flex-col gap-5 overflow-auto px-7 py-5">
      {GROUPS.map(([label, risk]) => {
        const inGroup = groups.filter(g => g.category.risk === risk)
        if (inGroup.length === 0) return null
        return (
          <section key={risk} className="flex flex-col gap-2.5">
            <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">{label}</h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
              {inGroup.map(({category}) => {
                const lit = sectionState(category, selection).picked > 0
                return (
                  <div
                    key={category.id}
                    className={`flex flex-col gap-3 rounded-xl border p-4 ${STATE_MOTION} ${lit ? 'border-blue-400/45 bg-blue-400/5' : 'bg-card'}`}
                  >
                    <div className="flex items-center gap-2.5">
                      <SectionCheckbox category={category} selection={selection} locked={progress !== null} />
                      <span className="grow text-sm font-medium">{category.title}</span>
                      <Badge className={RISK_BADGE[category.risk]}>{RISK_LABEL[category.risk]}</Badge>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-semibold tracking-tight tabular-nums">{formatBytes(category.bytes)}</span>
                      <span className="text-xs text-muted-foreground">{pickedLabel(category, selection, progress)}</span>
                    </div>
                    <p className="grow text-xs leading-relaxed text-muted-foreground">{category.desc}</p>
                    <Button variant="link" size="xs" className="t-learn self-start px-0" onClick={() => onOpen(category.id)}>
                      Show items <LearnChevron />
                    </Button>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

type SetFilters = (update: (f: Filters) => Filters) => void

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

function SearchBox({value, onChange, inputRef}: {value: string; onChange: (q: string) => void; inputRef: RefObject<HTMLInputElement | null>}) {
  return (
    <div className="relative w-72">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key !== 'Escape') return
          onChange('')
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

function Toolbar({filters, setFilters, view, onView, searchRef}: {filters: Filters; setFilters: SetFilters; view: View; onView: (view: View) => void; searchRef: RefObject<HTMLInputElement | null>}) {
  const toggleRisk = (risk: Risk) =>
    setFilters(f => ({...f, risks: f.risks.includes(risk) ? f.risks.filter(r => r !== risk) : [...f.risks, risk]}))
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-7 py-3">
      <SearchBox value={filters.q} onChange={q => setFilters(f => ({...f, q}))} inputRef={searchRef} />
      {RISKS.map(risk => (
        <Toggle key={risk} on={filters.risks.includes(risk)} label={RISK_LABEL[risk]} onClick={() => toggleRisk(risk)} />
      ))}
      <FilterSelect label="Minimum size" value={filters.minBytes} options={MIN_SIZES} render={n => (n === 0 ? 'Any size' : `≥ ${formatBytes(n)}`)} onChange={minBytes => setFilters(f => ({...f, minBytes}))} />
      <FilterSelect label="Minimum idle time" value={filters.minAge} options={MIN_AGES} render={n => (n === -1 ? 'Any age' : `Idle ${n}+ days`)} onChange={minAge => setFilters(f => ({...f, minAge}))} />
      <FilterSelect label="Sort" value={filters.sort} options={SORTS} render={s => SORT_LABEL[s]} onChange={sort => setFilters(f => ({...f, sort}))} />
      <Toggle on={filters.onlySelected} label="Only selected" onClick={() => setFilters(f => ({...f, onlySelected: !f.onlySelected}))} />
      <span className="grow" />
      <ToggleGroup value={[view]} onValueChange={v => v[0] && onView(v[0] as View)} variant="outline" size="sm" aria-label="View">
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

function WarningLines({hidden, risky}: {hidden: Item[]; risky: Item[]}) {
  return (
    <div className="flex flex-col gap-1 border-b bg-amber-500/5 px-7 py-2 text-xs text-amber-200">
      {hidden.length > 0 && (
        <Warning>
          {plural(hidden.length, 'selected item is', 'selected items are')} hidden by the filters (
          {formatBytes(hidden.reduce((sum, i) => sum + i.bytes, 0))}). They will still be deleted.
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

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

function useShortcuts(actions: Record<string, () => void>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = actions[event.key]
      const typing = (event.target as HTMLElement).closest('input, select, textarea, [role="dialog"], [role="listbox"]')
      if (!action || typing || event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

function useStoredView() {
  const [view, setView] = useState(readView)
  const change = (next: View) => {
    setView(next)
    saveView(next)
  }
  return [view, change] as const
}

function groupItems(categories: Category[], filters: Filters, selection: Selection): Group[] {
  return categories
    .map(category => {
      const items = sortItems(category.items.filter(i => matches(filters, selection, category, i)), filters.sort)
      return {category, items, bytes: items.reduce((sum, i) => sum + i.bytes, 0)}
    })
    .filter(g => g.items.length > 0)
}

const LOCKED_KEYS = new Set(['a', 'd', 'r'])

export function Cleanup({categories, selection, progress = null}: {categories: Category[]; selection: Selection; progress?: CleanupProgress | null}) {
  const [filters, setFilters] = useState(NO_FILTERS)
  const [view, setView] = useStoredView()
  const [active, setActive] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const reveal = useReveal(view)
  const groups = useMemo(() => groupItems(categories, filters, selection), [categories, filters, selection])
  const shown = new Set(groups.flatMap(g => g.items.map(i => i.path)))

  const shortcuts: Record<string, () => void> = {
    '/': () => search.current?.focus(),
    a: () => selection.set(groups.flatMap(g => g.items), true),
    d: () => selection.set(categories.flatMap(c => c.items), false),
    r: () => selection.reset(),
    v: () => setView(view === 'list' ? 'cards' : 'list'),
  }
  useShortcuts(progress ? Object.fromEntries(Object.entries(shortcuts).filter(([key]) => !LOCKED_KEYS.has(key))) : shortcuts)

  const open = (id: string) => {
    setActive(id)
    setView('list')
  }
  const body =
    groups.length === 0 ? (
      <div className="flex grow flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        Nothing matches these filters.
        <Button variant="outline" size="sm" onClick={() => setFilters(NO_FILTERS)}>
          Clear filters
        </Button>
      </div>
    ) : view === 'list' ? (
      <ListView groups={groups} selection={selection} active={active} onActive={setActive} progress={progress} />
    ) : (
      <CardsView groups={groups} selection={selection} onOpen={open} progress={progress} />
    )

  return (
    <div className="flex min-h-0 grow flex-col">
      <Toolbar filters={filters} setFilters={setFilters} view={view} onView={setView} searchRef={search} />
      <Warnings hidden={selection.selected.filter(i => !shown.has(i.path))} risky={selection.risky} />
      <div ref={reveal} data-open="true" className="t-panel-slide flex min-h-0 grow flex-col">
        {body}
      </div>
    </div>
  )
}

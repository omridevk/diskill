import type {RowSelectionState} from '@tanstack/react-table'
import {useMemo, useSyncExternalStore} from 'react'
import type {Db} from './db'
import type {Entry} from './scan-feed'
import type {CleanupSearch, Sort} from './search'
import {useVersion} from './views'

type Shape = Pick<CleanupSearch, 'q' | 'risk' | 'minSize' | 'minAge' | 'sort' | 'only'>

export const isFiltering = (shape: Shape) => shape.q !== '' || shape.risk.length > 0 || shape.minSize > 0 || shape.minAge >= 0 || shape.only

export function predicateOf(shape: Shape, on: RowSelectionState) {
  const q = shape.q.toLowerCase()
  const risks = new Set(shape.risk)
  return (entry: Entry) =>
    entry.search.includes(q) &&
    (risks.size === 0 || risks.has(entry.risk)) &&
    entry.bytes >= shape.minSize &&
    (shape.minAge < 0 || (entry.age ?? -1) >= shape.minAge) &&
    (!shape.only || on[entry.path] === true)
}

const onIds = new WeakMap<RowSelectionState, number>()
const counter = {next: 0}

function onKey(on: RowSelectionState) {
  const known = onIds.get(on)
  if (known !== undefined) return known
  counter.next += 1
  onIds.set(on, counter.next)
  return counter.next
}

const filterKey = (shape: Shape, on: RowSelectionState) => [shape.q, shape.risk.join(','), shape.minSize, shape.minAge, shape.only ? onKey(on) : ''].join('|')

type Group = Db['scan']['bySection'] extends Map<string, infer G> ? G : never
type Compare = (a: Entry, b: Entry) => number

const DIGITS = /\d+/g
const MARKS = /\p{M}/gu
const nameKeys = new WeakMap<Entry, string>()

function nameKey(entry: Entry) {
  const known = nameKeys.get(entry)
  if (known !== undefined) return known
  const key = entry.label
    .normalize('NFD')
    .replace(MARKS, '')
    .toLowerCase()
    .replace(DIGITS, digits => digits.padStart(16, '0'))
  nameKeys.set(entry, key)
  return key
}

const byText = (a: string, b: string) => (a < b ? -1 : Number(a > b))
const byPath: Compare = (a, b) => byText(a.path, b.path)
const bySizeThenPath: Compare = (a, b) => b.bytes - a.bytes || byPath(a, b)

function byAge(direction: 1 | -1): Compare {
  return (a, b) => {
    if (a.age === null || b.age === null) return Number(a.age === null) - Number(b.age === null) || bySizeThenPath(a, b)
    return direction * (a.age - b.age) || bySizeThenPath(a, b)
  }
}

const ORDER: Record<Sort, Compare> = {
  'size-desc': bySizeThenPath,
  'size-asc': (a, b) => a.bytes - b.bytes || byPath(a, b),
  'name-asc': (a, b) => byText(nameKey(a), nameKey(b)) || bySizeThenPath(a, b),
  'age-desc': byAge(-1),
  'age-asc': byAge(1),
}

interface Sorted {
  version: number
  rows: Entry[]
  members: Map<string, Entry>
}

function insertAt(rows: readonly Entry[], entry: Entry, compare: Compare) {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const row = rows[middle]
    if (row && compare(row, entry) < 0) low = middle + 1
    else high = middle
  }
  return low
}

function patched(known: Sorted, group: Group, compare: Compare): Entry[] | null {
  const changed: Entry[] = []
  for (const entry of group.items.values()) if (known.members.get(entry.path) !== entry) changed.push(entry)
  const gone = known.members.size + changed.length - group.items.size
  if (changed.length + gone > group.items.size / 4) return null
  const rows = gone > 0 || changed.length > 0 ? known.rows.filter(row => group.items.get(row.path) === row) : known.rows
  for (const entry of changed) rows.splice(insertAt(rows, entry, compare), 0, entry)
  return rows
}

function storeOf<T>(by: WeakMap<Db, Map<string, T>>, db: Db) {
  const known = by.get(db) ?? new Map<string, T>()
  by.set(db, known)
  return known
}

const KEEP = 8

function remember<T>(store: Map<string, T>, key: string, value: T) {
  store.delete(key)
  store.set(key, value)
  for (const old of [...store.keys()].slice(0, Math.max(0, store.size - KEEP))) store.delete(old)
  return value
}

const sortedBy = new WeakMap<Db, Map<string, Sorted>>()
const NOTHING: Sorted = {version: -1, rows: [], members: new Map()}

function sortedOf(db: Db, section: string, sort: Sort): Sorted {
  const group = db.scan.bySection.get(section)
  if (!group) return NOTHING
  const store = storeOf(sortedBy, db)
  const key = `${section}|${sort}`
  const known = store.get(key)
  if (known?.version === group.version) return known
  const compare = ORDER[sort]
  const rows = (known && patched(known, group, compare)) ?? [...group.items.values()].sort(compare)
  return remember(store, key, {version: group.version, rows, members: new Map(group.items)})
}

export interface SectionTotal {
  id: string
  count: number
  bytes: number
  selectable: number
  aged: number
}

interface CachedTotal {
  version: number
  total: SectionTotal
}

function totalOf(id: string, group: Group, keep: (entry: Entry) => boolean): SectionTotal {
  const total = {id, count: 0, bytes: 0, selectable: 0, aged: 0}
  for (const entry of group.items.values()) {
    if (!keep(entry)) continue
    total.count += 1
    total.bytes += entry.bytes
    total.selectable += entry.selectable
    if (entry.age !== null) total.aged += 1
  }
  return total
}

const totalsBy = new WeakMap<Db, Map<string, Map<string, CachedTotal>>>()

function totalsNow(db: Db, shape: Shape, on: RowSelectionState): SectionTotal[] {
  const store = storeOf(totalsBy, db)
  const key = filterKey(shape, on)
  const bySection = remember(store, key, store.get(key) ?? new Map<string, CachedTotal>())
  const keep = predicateOf(shape, on)
  const totals: SectionTotal[] = []
  for (const [id, group] of db.scan.bySection) {
    const known = bySection.get(id)
    const cached = known?.version === group.version ? known : {version: group.version, total: totalOf(id, group, keep)}
    bySection.set(id, cached)
    if (cached.total.count > 0) totals.push(cached.total)
  }
  return totals
}

export function useShapedTotals(db: Db, shape: Shape, on: RowSelectionState): SectionTotal[] {
  const items = useVersion(db.scan.items.collection)
  return useMemo(() => totalsNow(db, shape, on), [db, shape, on, items])
}

interface Shown {
  sorted: Sorted
  rows: Entry[]
}

const shownBy = new WeakMap<Db, Map<string, Shown>>()

function shownOf(db: Db, section: string, shape: Shape, on: RowSelectionState) {
  const sorted = sortedOf(db, section, shape.sort)
  const store = storeOf(shownBy, db)
  const key = `${section}|${shape.sort}|${filterKey(shape, on)}`
  const known = store.get(key)
  if (known?.sorted === sorted) return known.rows
  const rows = isFiltering(shape) ? sorted.rows.filter(predicateOf(shape, on)) : sorted.rows
  return remember(store, key, {sorted, rows}).rows
}

function createWindows() {
  const offsets = new Map<string, number>()
  const listeners = new Set<() => void>()
  return {
    offsetOf: (key: string) => offsets.get(key) ?? 0,
    move: (key: string, offset: number) => {
      if (offsets.get(key) === offset) return
      offsets.set(key, offset)
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const windowsBy = new WeakMap<Db, ReturnType<typeof createWindows>>()

function windowsOf(db: Db) {
  const known = windowsBy.get(db) ?? createWindows()
  windowsBy.set(db, known)
  return known
}

const WINDOW = 240

export interface SectionWindow {
  rows: Entry[]
  offset: number
  move: (offset: number) => void
}

export function useSectionWindow(db: Db, section: string, shape: Shape, on: RowSelectionState): SectionWindow {
  const items = useVersion(db.scan.items.collection)
  const windows = windowsOf(db)
  const key = `${section}|${shape.sort}|${filterKey(shape, on)}`
  const offset = useSyncExternalStore(windows.subscribe, () => windows.offsetOf(key))
  const shown = useMemo(() => shownOf(db, section, shape, on), [db, section, shape, on, items])
  return useMemo(() => ({rows: shown.slice(offset, offset + WINDOW), offset, move: next => windows.move(key, next)}), [shown, offset, windows, key])
}

export function moveWindow(window: SectionWindow, start: number, end: number) {
  if (start >= window.offset && end <= window.offset + window.rows.length) return
  window.move(Math.max(0, start - WINDOW / 4))
}

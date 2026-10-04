import {count, createLiveQueryCollection, eq, sum, type InitialQueryBuilder} from '@tanstack/react-db'
import type {RowSelectionState} from '@tanstack/react-table'
import {useMemo} from 'react'
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

const filterKey = (shape: Shape, on: RowSelectionState) => [shape.q, shape.risk.join(','), shape.minSize, shape.minAge, shape.only ? onKey(on) : ''].join('|')

const onIds = new WeakMap<RowSelectionState, number>()
let nextOn = 0

function onKey(on: RowSelectionState) {
  const known = onIds.get(on)
  if (known !== undefined) return known
  nextOn += 1
  onIds.set(on, nextOn)
  return nextOn
}

const naturally = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'})

type Items = Db['scan']['items']['collection']

function sectionOf(items: Items, section: string) {
  return (q: InitialQueryBuilder) => q.from({i: items}).where(({i}) => eq(i.section, section))
}

type Base = ReturnType<ReturnType<typeof sectionOf>>

const ORDER: Record<Sort, (base: Base) => Base> = {
  'size-desc': base => base.orderBy(({i}) => i.bytes, 'desc'),
  'size-asc': base => base.orderBy(({i}) => i.bytes, 'asc'),
  'name-asc': base => base.orderBy(({i}) => i.label, {stringSort: 'custom', compare: naturally.compare}),
  'age-desc': base => base.orderBy(({i}) => i.age, {direction: 'desc', nulls: 'last'}),
  'age-asc': base => base.orderBy(({i}) => i.age, {direction: 'asc', nulls: 'last'}),
}

const WINDOW = 120
const KEEP = 6

function totalsQuery(items: Items, keep: (entry: Entry) => boolean) {
  return createLiveQueryCollection({
    query: q =>
      q
        .from({i: items})
        .fn.where(({i}) => keep(i))
        .groupBy(({i}) => i.section)
        .select(({i}) => ({id: i.section, count: count(i.path), bytes: sum(i.bytes), selectable: sum(i.selectable), aged: count(i.age)})),
    gcTime: 5000,
    startSync: true,
  })
}

function rowsQuery(items: Items, section: string, sort: Sort, keep: (entry: Entry) => boolean) {
  return createLiveQueryCollection({
    query: q =>
      ORDER[sort](sectionOf(items, section)(q))
        .orderBy(({i}) => i.bytes, 'desc')
        .orderBy(({i}) => i.path)
        .fn.where(({i}) => keep(i))
        .limit(WINDOW)
        .offset(0),
    gcTime: 5000,
    startSync: true,
  })
}

type Totals = ReturnType<typeof totalsQuery>
type Rows = ReturnType<typeof rowsQuery>

function cached<T>(store: Map<string, T>, key: string, make: () => T) {
  const known = store.get(key)
  if (known) return known
  const made = make()
  store.set(key, made)
  for (const old of [...store.keys()].slice(0, Math.max(0, store.size - KEEP))) store.delete(old)
  return made
}

const totalsBy = new WeakMap<Items, Map<string, Totals>>()
const rowsBy = new WeakMap<Items, Map<string, Rows>>()

function storeOf<T>(by: WeakMap<Items, Map<string, T>>, items: Items) {
  const known = by.get(items) ?? new Map<string, T>()
  by.set(items, known)
  return known
}

export interface SectionTotal {
  id: string
  count: number
  bytes: number
  selectable: number
  aged: number
}

function totalsOf(db: Db, shape: Shape, on: RowSelectionState) {
  const items = db.scan.items.collection
  return cached(storeOf(totalsBy, items), filterKey(shape, on), () => totalsQuery(items, predicateOf(shape, on)))
}

function rowsOf(db: Db, section: string, shape: Shape, on: RowSelectionState) {
  const items = db.scan.items.collection
  return cached(storeOf(rowsBy, items), `${section}|${shape.sort}|${filterKey(shape, on)}`, () => rowsQuery(items, section, shape.sort, predicateOf(shape, on)))
}

export function prepare(db: Db, from: Shape, to: Shape, on: RowSelectionState) {
  const shown = `|${from.sort}|${filterKey(from, on)}`
  const sections = [...storeOf(rowsBy, db.scan.items.collection).keys()].filter(key => key.endsWith(shown)).map(key => key.slice(0, -shown.length))
  totalsOf(db, to, on)
  for (const section of sections) rowsOf(db, section, to, on)
}

export function useShapedTotals(db: Db, shape: Shape, on: RowSelectionState): SectionTotal[] {
  const collection = totalsOf(db, shape, on)
  const version = useVersion(collection)
  return useMemo(() => collection.toArray, [collection, version])
}

export interface SectionWindow {
  rows: Entry[]
  offset: number
  collection: Rows
}

export function useSectionWindow(db: Db, section: string, shape: Shape, on: RowSelectionState): SectionWindow {
  const collection = rowsOf(db, section, shape, on)
  const version = useVersion(collection)
  return useMemo(() => ({rows: collection.toArray, offset: collection.utils.getWindow()?.offset ?? 0, collection}), [collection, version])
}

export function moveWindow(window: SectionWindow, start: number, end: number) {
  const current = window.collection.utils.getWindow()
  const offset = Math.max(0, start - WINDOW / 4)
  const inside = current && start >= current.offset && end <= current.offset + current.limit
  if (inside) return
  void window.collection.utils.setWindow({offset, limit: Math.max(WINDOW, end - offset + WINDOW / 4)})
}

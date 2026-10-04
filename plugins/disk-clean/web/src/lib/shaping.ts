import {and, count, eq, gte, inArray, like, sum, useLiveQuery, type InitialQueryBuilder, type LiveQueryCollectionUtils, type Ref} from '@tanstack/react-db'
import type {RowSelectionState} from '@tanstack/react-table'
import {useMemo, useState} from 'react'
import type {Db} from './db'
import type {Entry} from './scan-feed'
import type {CleanupSearch, Sort} from './search'

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

const LIKE_WILDCARDS = /[%_]/g

function conditions(i: Ref<Entry>, shape: Shape, section: string | null) {
  const q = shape.q.toLowerCase().replace(LIKE_WILDCARDS, '_')
  return [
    ...(section === null ? [] : [eq(i.section, section)]),
    ...(q === '' ? [] : [like(i.search, `%${q}%`)]),
    ...(shape.risk.length === 0 ? [] : [inArray(i.risk, shape.risk)]),
    ...(shape.minSize > 0 ? [gte(i.bytes, shape.minSize)] : []),
    ...(shape.minAge >= 0 ? [gte(i.age, shape.minAge)] : []),
  ]
}

const narrows = (shape: Shape, section: string | null) => section !== null || isFiltering({...shape, only: false})

type Items = Db['scan']['items']['collection']

function filtered(q: InitialQueryBuilder, items: Items, shape: Shape, on: RowSelectionState, section: string | null) {
  const base = q.from({i: items})
  const narrowed = narrows(shape, section) ? base.where(({i}) => conditions(i, shape, section).reduce((left, right) => and(left, right))) : base
  return shape.only ? narrowed.fn.where(({i}) => on[i.path] === true) : narrowed
}

type Base = ReturnType<typeof filtered>

const ORDER: Record<Sort, (base: Base) => Base> = {
  'size-desc': base => base.orderBy(({i}) => i.bytes, 'desc'),
  'size-asc': base => base.orderBy(({i}) => i.bytes, 'asc'),
  'name-asc': base => base.orderBy(({i}) => i.order, {direction: 'asc', stringSort: 'lexical'}),
  'age-desc': base => base.orderBy(({i}) => i.age, {direction: 'desc', nulls: 'last'}),
  'age-asc': base => base.orderBy(({i}) => i.age, {direction: 'asc', nulls: 'last'}),
}

const WINDOW = 240
const GC_TIME = 500

export interface SectionTotal {
  id: string
  count: number
  bytes: number
  selectable: number
  aged: number
}

function totalsQuery(q: InitialQueryBuilder, items: Items, shape: Shape, on: RowSelectionState) {
  return filtered(q, items, shape, on, null)
    .groupBy(({i}) => i.section)
    .select(({i}) => ({id: i.section, count: count(i.path), bytes: sum(i.bytes), selectable: sum(i.selectable), aged: count(i.age)}))
}

const UNFILTERED: Shape = {q: '', risk: [], minSize: 0, minAge: -1, sort: 'size-desc', only: false}

export function useTotals(db: Db): SectionTotal[] {
  const items = db.scan.items.collection
  return useLiveQuery({queryKey: ['totals', items.id], query: q => totalsQuery(q, items, UNFILTERED, {})}).data
}

export function useFilteredTotals(db: Db, shape: Shape, on: RowSelectionState): SectionTotal[] | undefined {
  const items = db.scan.items.collection
  return useLiveQuery({
    queryKey: ['totals', items.id, filterKey(shape, on)],
    gcTime: GC_TIME,
    query: q => (isFiltering(shape) ? totalsQuery(q, items, shape, on) : undefined),
  }).data
}

interface Requested {
  utils: object
  offset: number
  limit: number
}

const isWindowed = (utils: object): utils is LiveQueryCollectionUtils => 'setWindow' in utils

export function useSectionWindow(db: Db, section: string, shape: Shape, on: RowSelectionState) {
  const items = db.scan.items.collection
  const {data, collection} = useLiveQuery({
    queryKey: ['rows', items.id, section, shape.sort, filterKey(shape, on)],
    gcTime: GC_TIME,
    query: q =>
      ORDER[shape.sort](filtered(q, items, shape, on, section))
        .limit(WINDOW)
        .offset(0),
  })
  const {utils} = collection
  const [requested, setRequested] = useState<Requested | null>(null)
  const current = requested?.utils === utils ? requested : {utils, offset: 0, limit: WINDOW}
  return useMemo(() => {
    const move = (start: number, end: number) => {
      if (!isWindowed(utils) || (start >= current.offset && end <= current.offset + current.limit)) return
      const offset = Math.max(0, start - WINDOW / 4)
      const limit = Math.max(WINDOW, end - offset + WINDOW / 4)
      void utils.setWindow({offset, limit})
      setRequested({utils, offset, limit})
    }
    return {rows: data, offset: current.offset, move}
  }, [data, utils, current.offset, current.limit])
}

export type SectionWindow = ReturnType<typeof useSectionWindow>

export function moveWindow(window: SectionWindow, start: number, end: number) {
  window.move(start, end)
}

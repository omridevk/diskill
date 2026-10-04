import {and, eq, gte, like, useLiveQuery, type InitialQueryBuilder, type Ref} from '@tanstack/react-db'
import type {RowSelectionState} from '@tanstack/react-table'
import {useMemo} from 'react'
import type {Risk} from './data'
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

const LIKE_WILDCARDS = /[%_]/g

type Items = Db['scan']['items']['collection']

const shows = (shape: Shape, risk: Risk) => shape.risk.length === 0 || shape.risk.includes(risk)

function narrowed(i: Ref<Entry>, shape: Shape, own: ReturnType<typeof eq>) {
  const q = shape.q.toLowerCase().replace(LIKE_WILDCARDS, '_')
  return [
    own,
    ...(q === '' ? [] : [like(i.search, `%${q}%`)]),
    ...(shape.minSize > 0 ? [gte(i.bytes, shape.minSize)] : []),
    ...(shape.minAge >= 0 ? [gte(i.age, shape.minAge)] : []),
  ].reduce((left, right) => and(left, right))
}

function riskRows(q: InitialQueryBuilder, items: Items, shape: Shape, risk: Risk) {
  return shows(shape, risk) ? q.from({i: items}).where(({i}) => narrowed(i, shape, eq(i.risk, risk))) : undefined
}

type From = ReturnType<typeof fromItems>

const fromItems = (q: InitialQueryBuilder, items: Items) => q.from({i: items})

const ORDER: Record<Sort, (rows: From) => From> = {
  'size-desc': rows => rows.orderBy(({i}) => i.bytes, 'desc'),
  'size-asc': rows => rows.orderBy(({i}) => i.bytes, 'asc'),
  'name-asc': rows => rows.orderBy(({i}) => i.order, {direction: 'asc', stringSort: 'lexical'}),
  'age-desc': rows => rows.orderBy(({i}) => i.age, {direction: 'desc', nulls: 'last'}),
  'age-asc': rows => rows.orderBy(({i}) => i.age, {direction: 'asc', nulls: 'last'}),
}

export interface SectionTotal {
  id: string
  count: number
  bytes: number
  selectable: number
  aged: number
}

const UNFILTERED: Shape = {q: '', risk: [], minSize: 0, minAge: -1, sort: 'size-desc', only: false}

function totalsOf(groups: readonly (readonly Entry[] | undefined)[], on: RowSelectionState | null): SectionTotal[] {
  const totals = new Map<string, SectionTotal>()
  for (const rows of groups) {
    for (const row of rows ?? []) {
      if (on !== null && on[row.path] !== true) continue
      const total = totals.get(row.section) ?? {id: row.section, count: 0, bytes: 0, selectable: 0, aged: 0}
      total.count += 1
      total.bytes += row.bytes
      total.selectable += row.selectable
      total.aged += Number(row.age !== null && row.age !== undefined)
      totals.set(row.section, total)
    }
  }
  return [...totals.values()]
}

function useRiskRows(items: Items, shape: Shape | null, risk: Risk) {
  return useLiveQuery(q => (shape === null ? undefined : riskRows(q, items, shape, risk))).data
}

function useTotalsOf(db: Db, shape: Shape | null, on: RowSelectionState | null) {
  const items = db.scan.items.collection
  const safe = useRiskRows(items, shape, 'safe')
  const review = useRiskRows(items, shape, 'review')
  const report = useRiskRows(items, shape, 'report')
  return useMemo(() => totalsOf([safe, review, report], on), [safe, review, report, on])
}

export function useTotals(db: Db, shape: Shape, on: RowSelectionState) {
  const filtering = isFiltering(shape)
  const all = useTotalsOf(db, UNFILTERED, null)
  const shown = useTotalsOf(db, filtering ? shape : null, shape.only ? on : null)
  return {all, shown: filtering ? shown : all}
}

const NO_ROWS: Entry[] = []
const SORT_KEPT_MS = 5_000

export function useSectionRows(db: Db, section: {id: string; risk: Risk}, shape: Shape, on: RowSelectionState): readonly Entry[] {
  const items = db.scan.items.collection
  const {data} = useLiveQuery({
    query: q => (shows(shape, section.risk) ? ORDER[shape.sort](fromItems(q, items)).where(({i}) => narrowed(i, shape, eq(i.section, section.id))) : undefined),
    gcTime: SORT_KEPT_MS,
  })
  const rows = data ?? NO_ROWS
  return useMemo(() => (shape.only ? rows.filter(row => on[row.path] === true) : rows), [rows, shape.only, on])
}

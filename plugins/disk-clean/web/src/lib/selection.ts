import {functionalUpdate, type RowSelectionState, type Updater} from '@tanstack/react-table'
import {useCallback, useMemo, useReducer} from 'react'
import {isExact, type Category, type Item} from './data'

export interface Selection {
  rowSelection: RowSelectionState
  setRowSelection: (update: Updater<RowSelectionState>) => void
  isOn: (item: Item) => boolean
  reset: () => void
  selected: Item[]
  exactBytes: number
  apparentBytes: number
  risky: Item[]
}

export interface Picks {
  on: RowSelectionState
  offered: ReadonlySet<string>
}

type PickAction =
  | {type: 'offer'; items: readonly Item[]}
  | {type: 'select'; update: Updater<RowSelectionState>}
  | {type: 'reset'; items: readonly Item[]}

const pickable = (item: Item) => !item.report

function preselected(items: readonly Item[]): RowSelectionState {
  return Object.fromEntries(items.filter(i => i.preselect && pickable(i)).map(i => [i.path, true] as const))
}

function offer(picks: Picks, items: readonly Item[]): Picks {
  const fresh = items.filter(i => !picks.offered.has(i.path))
  if (fresh.length === 0) return picks
  return {on: {...picks.on, ...preselected(fresh)}, offered: new Set([...picks.offered, ...fresh.map(i => i.path)])}
}

export const NO_PICKS: Picks = {on: {}, offered: new Set()}

export function picksReducer(picks: Picks, action: PickAction): Picks {
  if (action.type === 'offer') return offer(picks, action.items)
  if (action.type === 'select') return {...picks, on: functionalUpdate(action.update, picks.on)}
  return {...picks, on: preselected(action.items)}
}

function startPicks(items: readonly Item[], chosen?: readonly string[]): Picks {
  if (!chosen) return offer(NO_PICKS, items)
  return {on: Object.fromEntries(chosen.map(path => [path, true] as const)), offered: new Set(items.map(i => i.path))}
}

function hasAncestorIn(path: string, paths: ReadonlySet<string>) {
  for (let slash = path.indexOf('/', 1); slash > 0; slash = path.indexOf('/', slash + 1)) {
    if (paths.has(path.slice(0, slash))) return true
  }
  return false
}

export function outermost<T extends {path: string}>(items: readonly T[]): T[] {
  const paths = new Set(items.map(i => i.path))
  return items.filter(i => !hasAncestorIn(i.path, paths))
}

export const sumBytes = (items: readonly {bytes: number}[]) => items.reduce((sum, i) => sum + i.bytes, 0)

function totalsOf(selected: readonly Item[]) {
  const counted = outermost(selected)
  return {exactBytes: sumBytes(counted.filter(isExact)), apparentBytes: sumBytes(counted.filter(i => !isExact(i)))}
}

export function useSelection(categories: readonly Category[], chosen?: readonly string[]): Selection {
  const all = useMemo(() => categories.flatMap(c => c.items).filter(pickable), [categories])
  const [picks, dispatch] = useReducer(picksReducer, all, items => startPicks(items, chosen))
  if (all.some(i => !picks.offered.has(i.path))) dispatch({type: 'offer', items: all})
  const review = useMemo(() => new Set(categories.filter(c => c.risk === 'review').flatMap(c => c.items.map(i => i.path))), [categories])
  const setRowSelection = useCallback((update: Updater<RowSelectionState>) => dispatch({type: 'select', update}), [])
  const reset = useCallback(() => dispatch({type: 'reset', items: all}), [all])
  const selected = useMemo(() => all.filter(i => picks.on[i.path] === true), [all, picks.on])
  const totals = useMemo(() => totalsOf(selected), [selected])
  return useMemo(
    () => ({
      rowSelection: picks.on,
      setRowSelection,
      isOn: (item: Item) => picks.on[item.path] === true,
      reset,
      selected,
      ...totals,
      risky: selected.filter(i => review.has(i.path)),
    }),
    [picks.on, setRowSelection, reset, selected, totals, review],
  )
}

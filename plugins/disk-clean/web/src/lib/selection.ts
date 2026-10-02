import {useCallback, useMemo, useReducer} from 'react'
import {isExact, type Category, type Item} from './data'

export interface Selection {
  isOn: (item: Item) => boolean
  set: (items: readonly Item[], on: boolean | ((item: Item) => boolean)) => void
  reset: () => void
  selected: Item[]
  exactBytes: number
  apparentBytes: number
  risky: Item[]
}

interface Picks {
  on: ReadonlySet<string>
  offered: ReadonlySet<string>
}

type PickAction =
  | {type: 'offer'; items: readonly Item[]}
  | {type: 'set'; items: readonly Item[]; value: boolean | ((item: Item) => boolean)}
  | {type: 'reset'; items: readonly Item[]}

const pickable = (item: Item) => !item.report

const preselected = (items: readonly Item[]) => items.filter(i => i.preselect && pickable(i)).map(i => i.path)

function offer(picks: Picks, items: readonly Item[]): Picks {
  const fresh = items.filter(i => !picks.offered.has(i.path))
  if (fresh.length === 0) return picks
  return {on: new Set([...picks.on, ...preselected(fresh)]), offered: new Set([...picks.offered, ...fresh.map(i => i.path)])}
}

function setPicks(picks: Picks, items: readonly Item[], value: boolean | ((item: Item) => boolean)): Picks {
  const on = new Set(picks.on)
  for (const item of items.filter(pickable)) {
    const wanted = typeof value === 'function' ? value(item) : value
    if (wanted) on.add(item.path)
    else on.delete(item.path)
  }
  return {...picks, on}
}

export const NO_PICKS: Picks = {on: new Set(), offered: new Set()}

export function picksReducer(picks: Picks, action: PickAction): Picks {
  if (action.type === 'offer') return offer(picks, action.items)
  if (action.type === 'set') return setPicks(picks, action.items, action.value)
  return {...picks, on: new Set(preselected(action.items))}
}

export function useSelection(categories: readonly Category[]): Selection {
  const all = useMemo(() => categories.flatMap(c => c.items).filter(pickable), [categories])
  const [picks, dispatch] = useReducer(picksReducer, all, items => offer(NO_PICKS, items))
  if (all.some(i => !picks.offered.has(i.path))) dispatch({type: 'offer', items: all})
  const riskOf = useMemo(() => new Map(categories.flatMap(c => c.items.map(i => [i.path, c.risk] as const))), [categories])

  const set = useCallback(
    (items: readonly Item[], value: boolean | ((item: Item) => boolean)) => dispatch({type: 'set', items, value}),
    [],
  )

  const selected = useMemo(() => all.filter(i => picks.on.has(i.path)), [all, picks.on])

  return {
    isOn: item => picks.on.has(item.path),
    set,
    reset: () => dispatch({type: 'reset', items: all}),
    selected,
    exactBytes: selected.filter(isExact).reduce((sum, i) => sum + i.bytes, 0),
    apparentBytes: selected.filter(i => !isExact(i)).reduce((sum, i) => sum + i.bytes, 0),
    risky: selected.filter(i => riskOf.get(i.path) === 'review'),
  }
}

export function sectionState(category: Category, selection: Selection) {
  const items = category.items.filter(pickable)
  const picked = items.filter(selection.isOn).length
  return {
    items,
    picked,
    all: items.length > 0 && picked === items.length,
    some: picked > 0 && picked < items.length,
  }
}

import {useCallback, useMemo, useState} from 'react'
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

const pickable = (item: Item) => !item.report

export function useSelection(categories: readonly Category[]): Selection {
  const all = useMemo(() => categories.flatMap(c => c.items).filter(pickable), [categories])
  const initial = useCallback(() => new Set(all.filter(i => i.preselect).map(i => i.path)), [all])
  const [on, setOn] = useState(initial)
  const riskOf = useMemo(
    () => new Map(categories.flatMap(c => c.items.map(i => [i.path, c.risk] as const))),
    [categories],
  )

  const set = useCallback((items: readonly Item[], value: boolean | ((item: Item) => boolean)) => {
    setOn(previous => {
      const next = new Set(previous)
      for (const item of items.filter(pickable)) {
        const wanted = typeof value === 'function' ? value(item) : value
        if (wanted) next.add(item.path)
        else next.delete(item.path)
      }
      return next
    })
  }, [])

  const selected = useMemo(() => all.filter(i => on.has(i.path)), [all, on])

  return {
    isOn: item => on.has(item.path),
    set,
    reset: () => setOn(initial()),
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

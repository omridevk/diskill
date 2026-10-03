import {createAtom, useAtom, type Atom} from '@tanstack/react-store'
import {useState} from 'react'
import type {Risk} from './data'

export type View = 'list' | 'cards'
export type Sort = 'size-desc' | 'size-asc' | 'name-asc' | 'age-desc' | 'age-asc'
export type LogFilter = 'all' | 'removed' | 'problems' | 'commands'

export interface ListView {
  view: View
  q: string
  risk: Risk[]
  minSize: number
  minAge: number
  sort: Sort
  only: boolean
  section: string
}

export type ChangeList = (patch: Partial<ListView>) => void

export const NO_FILTERS = {q: '', risk: [], minSize: 0, minAge: -1, only: false} satisfies Partial<ListView>

const VIEW_KEY = 'disk-clean:view'

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'list'
  } catch {
    return 'list'
  }
}

function saveView(view: View) {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    return
  }
}

const startList = (): ListView => ({...NO_FILTERS, view: readView(), sort: 'size-desc', section: ''})

export type ListViewAtom = Atom<ListView>

export function useListViewAtom(): ListViewAtom {
  const [atom] = useState(() => createAtom(startList()))
  return atom
}

export function useListView(atom: ListViewAtom) {
  const [list, setList] = useAtom(atom)
  const change: ChangeList = patch => {
    if (patch.view) saveView(patch.view)
    setList(current => ({...current, ...patch}))
  }
  return [list, change] as const
}

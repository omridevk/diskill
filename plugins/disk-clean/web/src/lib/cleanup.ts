import {useEffect, useReducer} from 'react'
import type {Category, Item, OpenEvents} from './data'
import {messageData, openEventSource} from './live'

type Timed<T> = T & {elapsed_ms: number}

export type CleanupEvent =
  | {type: 'waiting'; data: object}
  | {type: 'started'; data: Timed<{free: number; paths: number; worktrees: number; commands: number; bytes: number}>}
  | {type: 'removed'; data: Timed<{path: string; bytes: number; secs: number}>}
  | {type: 'failed'; data: Timed<{path: string; bytes: number; reason: string}>}
  | {type: 'worktree'; data: Timed<{path: string; bytes: number; outcome: 'removed' | 'kept'; reason: string}>}
  | {type: 'command'; data: Timed<{id: string; label: string; status: 'ok' | 'failed'}>}
  | {type: 'free'; data: Timed<{free: number}>}
  | {type: 'done'; data: Timed<{free_before: number; free_after: number; reclaimed: number}>}

type Of<K extends CleanupEvent['type']> = Extract<CleanupEvent, {type: K}>['data']

export interface Cleanup {
  log: CleanupEvent[]
  keys: ReadonlySet<string>
  started: Of<'started'> | null
  done: Of<'done'> | null
  free: Of<'free'> | null
}

export const NO_CLEANUP: Cleanup = {log: [], keys: new Set(), started: null, done: null, free: null}

const TYPES: CleanupEvent['type'][] = ['waiting', 'started', 'removed', 'failed', 'worktree', 'command', 'free', 'done']

function keyOf(event: CleanupEvent) {
  switch (event.type) {
    case 'removed':
    case 'failed':
    case 'worktree':
      return event.data.path
    case 'command':
      return `cmd:${event.data.id}`
    case 'free':
      return `free:${event.data.elapsed_ms}`
    default:
      return event.type
  }
}

export function cleanupReducer(cleanup: Cleanup, event: CleanupEvent): Cleanup {
  const key = keyOf(event)
  if (cleanup.keys.has(key)) return cleanup
  const next = {...cleanup, log: [...cleanup.log, event], keys: new Set([...cleanup.keys, key])}
  if (event.type === 'started') return {...next, started: event.data}
  if (event.type === 'done') return {...next, done: event.data}
  if (event.type === 'free' && event.data.elapsed_ms >= (cleanup.free?.elapsed_ms ?? 0)) return {...next, free: event.data}
  return next
}

function isWorkerDone(type: CleanupEvent['type'], data: unknown) {
  return type !== 'done' || (typeof data === 'object' && data !== null && 'reclaimed' in data)
}

export function useCleanup(token: string, active: boolean, openEvents: OpenEvents = openEventSource) {
  const [cleanup, dispatch] = useReducer(cleanupReducer, NO_CLEANUP)
  useEffect(() => {
    if (!active) return
    const source = openEvents(`/events?token=${encodeURIComponent(token)}`)
    for (const type of TYPES) {
      source.addEventListener(type, message => {
        const data = messageData(message)
        if (data === null || !isWorkerDone(type, data)) return
        dispatch({type, data} as CleanupEvent)
        if (type === 'done') source.close()
      })
    }
    return () => source.close()
  }, [token, active, openEvents])
  return cleanup
}

export interface Planned {
  path: string
  label: string
  bytes: number
  section: string
}

export interface Section {
  id: string
  title: string
  bytes: number
  count: number
}

export interface FilmPlan {
  items: ReadonlyMap<string, Planned>
  sections: Section[]
  approved: number
  total: number
  headline: ReadonlySet<string>
}

const HEADLINE = 6

export function filmPlan(categories: readonly Category[], selected: readonly Item[], approved: number, total: number): FilmPlan {
  const chosen = new Set(selected.map(i => i.path))
  const sections: Section[] = []
  const items = new Map<string, Planned>()
  for (const category of categories) {
    const mine = category.items.filter(i => chosen.has(i.path))
    if (mine.length === 0) continue
    sections.push({id: category.id, title: category.title, bytes: mine.reduce((sum, i) => sum + i.bytes, 0), count: mine.length})
    for (const i of mine) items.set(i.path, {path: i.path, label: i.label, bytes: i.bytes, section: category.id})
  }
  const headline = new Set(
    [...items.values()]
      .filter(i => !i.path.startsWith('cmd:'))
      .toSorted((a, b) => b.bytes - a.bytes)
      .slice(0, HEADLINE)
      .map(i => i.path),
  )
  return {items, sections, approved, total, headline}
}

export interface Outcome {
  kind: 'removed' | 'failed' | 'kept' | 'ran'
  key: string
  label: string
  bytes: number
  section: string
  reason: string
}

function planned(plan: FilmPlan, key: string, bytes: number, label = key): Pick<Outcome, 'label' | 'bytes' | 'section'> {
  const known = plan.items.get(key)
  return {label: known?.label ?? label, bytes: known?.bytes ?? bytes, section: known?.section ?? ''}
}

export function outcomeOf(plan: FilmPlan, event: CleanupEvent): Outcome | null {
  switch (event.type) {
    case 'removed':
      return {kind: 'removed', key: event.data.path, reason: '', ...planned(plan, event.data.path, event.data.bytes)}
    case 'failed':
      return {kind: 'failed', key: event.data.path, reason: event.data.reason, ...planned(plan, event.data.path, event.data.bytes)}
    case 'worktree':
      return {
        kind: event.data.outcome === 'kept' ? 'kept' : 'removed',
        key: event.data.path,
        reason: event.data.reason,
        ...planned(plan, event.data.path, event.data.bytes),
      }
    case 'command': {
      const key = `cmd:${event.data.id}`
      const failed = event.data.status !== 'ok'
      return {kind: failed ? 'failed' : 'ran', key, reason: failed ? `${event.data.label} failed` : '', ...planned(plan, key, 0, event.data.label)}
    }
    default:
      return null
  }
}

export function outcomes(plan: FilmPlan, log: readonly CleanupEvent[]) {
  return log.flatMap(e => outcomeOf(plan, e) ?? [])
}

export interface Totals {
  removed: Outcome[]
  failed: Outcome[]
  kept: Outcome[]
  sections: number
  biggest: Outcome | null
  reclaimed: number
  seconds: number
}

export function totalsOf(all: readonly Outcome[], done: Of<'done'> | null): Totals {
  const removed = all.filter(o => o.kind === 'removed')
  return {
    removed,
    failed: all.filter(o => o.kind === 'failed'),
    kept: all.filter(o => o.kind === 'kept'),
    sections: new Set(removed.map(o => o.section)).size,
    biggest: removed.reduce<Outcome | null>((best, o) => (best && best.bytes >= o.bytes ? best : o), null),
    reclaimed: Math.max(0, done?.reclaimed ?? removed.reduce((sum, o) => sum + o.bytes, 0)),
    seconds: Math.round((done?.elapsed_ms ?? 0) / 1000),
  }
}

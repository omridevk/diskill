import {useEffect, useMemo, useReducer, useState} from 'react'
import type {Category, EventSourceLike, Item, OpenEvents} from './data'
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
  log: readonly CleanupEvent[]
  seen: ReadonlyMap<string, number>
  waiting: boolean
  started: Of<'started'> | null
  done: Of<'done'> | null
  free: Of<'free'> | null
}

export const NO_CLEANUP: Cleanup = {log: [], seen: new Map(), waiting: false, started: null, done: null, free: null}

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

function seenIn(cleanup: Cleanup) {
  return cleanup.log.length === 0 ? new Map<string, number>() : (cleanup.seen as Map<string, number>)
}

function absorb(cleanup: Cleanup, event: CleanupEvent): Cleanup {
  switch (event.type) {
    case 'waiting':
      return {...cleanup, waiting: true}
    case 'started':
      return {...cleanup, started: event.data}
    case 'done':
      return {...cleanup, done: event.data}
    case 'free':
      return event.data.elapsed_ms >= (cleanup.free?.elapsed_ms ?? 0) ? {...cleanup, free: event.data} : cleanup
    default:
      return cleanup
  }
}

export function cleanupReducer(cleanup: Cleanup, events: readonly CleanupEvent[]): Cleanup {
  const seen = seenIn(cleanup)
  const length = cleanup.log.length
  const added: CleanupEvent[] = []
  const batch = new Set<string>()
  let next = cleanup
  for (const event of events) {
    const key = keyOf(event)
    if ((seen.get(key) ?? length) < length || batch.has(key)) continue
    batch.add(key)
    seen.set(key, length + added.length)
    added.push(event)
    next = absorb(next, event)
  }
  return added.length === 0 ? cleanup : {...next, log: cleanup.log.concat(added), seen}
}

function isWorkerDone(type: CleanupEvent['type'], data: unknown) {
  return type !== 'done' || (typeof data === 'object' && data !== null && 'reclaimed' in data)
}

const CONNECTING = 0

function listenCleanup(source: EventSourceLike, take: (event: CleanupEvent) => void, setLost: (lost: boolean) => void) {
  for (const type of TYPES) {
    source.addEventListener(type, message => {
      const data = messageData(message)
      if (data === null || !isWorkerDone(type, data)) return
      setLost(false)
      take({type, data} as CleanupEvent)
      if (type === 'done') source.close()
    })
  }
  source.addEventListener('open', () => setLost(false))
  source.addEventListener('error', message => {
    if (!(message instanceof MessageEvent) && source.readyState === CONNECTING) setLost(true)
  })
}

function useCleanup(token: string, active: boolean, openEvents: OpenEvents = openEventSource) {
  const [cleanup, dispatch] = useReducer(cleanupReducer, NO_CLEANUP)
  const [lost, setLost] = useState(false)
  useEffect(() => {
    if (!active) return
    let queue: CleanupEvent[] = []
    let frame = 0
    const flush = () => {
      frame = 0
      dispatch(queue)
      queue = []
    }
    const take = (event: CleanupEvent) => {
      queue.push(event)
      if (frame === 0) frame = requestAnimationFrame(flush)
    }
    const source = openEvents(`/events?token=${encodeURIComponent(token)}`)
    listenCleanup(source, take, setLost)
    return () => {
      cancelAnimationFrame(frame)
      source.close()
    }
  }, [token, active, openEvents])
  return {cleanup, lost}
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
  at: number
  secs: number
}

function planned(plan: FilmPlan, key: string, bytes: number, label = key): Pick<Outcome, 'label' | 'bytes' | 'section'> {
  const known = plan.items.get(key)
  return {label: known?.label ?? label, bytes: known?.bytes ?? bytes, section: known?.section ?? ''}
}

function described(plan: FilmPlan, event: CleanupEvent): Omit<Outcome, 'at' | 'secs'> | null {
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
      return {kind: failed ? 'failed' : 'ran', key, reason: failed ? 'the command exited with an error' : '', ...planned(plan, key, 0, event.data.label)}
    }
    default:
      return null
  }
}

export function outcomeOf(plan: FilmPlan, event: CleanupEvent): Outcome | null {
  const outcome = described(plan, event)
  if (!outcome) return null
  return {...outcome, at: 'elapsed_ms' in event.data ? event.data.elapsed_ms : 0, secs: event.type === 'removed' ? event.data.secs : 0}
}

export function outcomes(plan: FilmPlan, log: readonly CleanupEvent[]) {
  return log.flatMap(e => outcomeOf(plan, e) ?? [])
}

export function useOutcomes(plan: FilmPlan | null, log: readonly CleanupEvent[]) {
  const cache = useMemo(() => new WeakMap<CleanupEvent, Outcome | null>(), [plan])
  return useMemo(() => {
    if (!plan) return []
    return log.flatMap(e => {
      if (!cache.has(e)) cache.set(e, outcomeOf(plan, e))
      return cache.get(e) ?? []
    })
  }, [plan, log, cache])
}

export interface CleanupProgress {
  plan: FilmPlan
  cleanup: Cleanup
  outcomes: readonly Outcome[]
  byKey: ReadonlyMap<string, Outcome>
  freed: number
  count: number
  total: number
  free: number | null
}

function progressOf(plan: FilmPlan, cleanup: Cleanup, all: readonly Outcome[]): CleanupProgress {
  const started = cleanup.started
  const removed = all.filter(o => o.kind === 'removed').reduce((sum, o) => sum + o.bytes, 0)
  return {
    plan,
    cleanup,
    outcomes: all,
    byKey: new Map(all.map(o => [o.key, o])),
    freed: cleanup.done ? Math.max(0, cleanup.done.reclaimed) : removed,
    count: all.length,
    total: started ? started.paths + started.worktrees + started.commands : plan.items.size,
    free: cleanup.done?.free_after ?? cleanup.free?.free ?? started?.free ?? null,
  }
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

export function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60)
  return m > 0 ? `${m}m ${seconds % 60}s` : `${seconds}s`
}

export function useCleanupProgress(token: string, plan: FilmPlan | null, openEvents?: OpenEvents) {
  const {cleanup, lost} = useCleanup(token, plan !== null, openEvents)
  const all = useOutcomes(plan, cleanup.log)
  const progress = useMemo(() => plan && progressOf(plan, cleanup, all), [plan, cleanup, all])
  return {progress, lost}
}

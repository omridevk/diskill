import {useEffect, useMemo, useReducer, useState} from 'react'
import type {Category, EventSourceLike, Item, OpenEvents} from './data'
import {messageData, openEventSource, perFrame} from './live'

type Timed<T> = T & {elapsed_ms: number}
type HeldItem = {job: string; path: string; held_path: string; bytes: number; reason: string}
type JobCounts = {job: string; kept: number; held: number; held_bytes: number}

export type CleanupEvent =
  | {type: 'waiting'; data: object}
  | {type: 'started'; data: Timed<{run: string; free: number; paths: number; worktrees: number; frees?: number; commands: number; bytes: number}>}
  | {type: 'removed'; data: Timed<{path: string; bytes: number; secs: number}>}
  | {type: 'failed'; data: Timed<{path: string; bytes: number; reason: string}>}
  | {type: 'kept'; data: Timed<{path: string; bytes: number; reason: string}>}
  | {type: 'worktree'; data: Timed<{path: string; bytes: number; outcome: 'removed' | 'kept'; reason: string}>}
  | {type: 'command'; data: Timed<{id: string; label: string; status: 'ok' | 'failed'}>}
  | {type: 'free'; data: Timed<{free: number}>}
  | {type: 'held'; data: Timed<{path: string; bytes: number; held_path: string}>}
  | {type: 'done'; data: Timed<{free_before: number; free_after: number; held?: number; held_bytes?: number; hold_until?: number | null}>}
  | {type: 'abandoned'; data: {reason: string}}
  | {type: 'freed'; data: Timed<HeldItem & {outcome: 'freed' | 'kept'}>}
  | {type: 'undone'; data: Timed<HeldItem & {outcome: 'restored' | 'kept' | 'gone'}>}
  | {type: 'free_started'; data: Timed<{job: string; count: number; bytes: number; free: number}>}
  | {type: 'free_done'; data: Timed<JobCounts & {freed: number; freed_bytes: number; free_before: number; free_after: number}>}
  | {type: 'undo_started'; data: Timed<{job: string; count: number; bytes: number}>}
  | {type: 'undo_done'; data: Timed<JobCounts & {restored: number; restored_bytes: number}>}

type Of<K extends CleanupEvent['type']> = Extract<CleanupEvent, {type: K}>['data']

export interface Keys {
  has: (key: string) => boolean
}

export interface Job {
  kind: 'free' | 'undo'
  id: string
  count: number
  bytes: number
  done: Of<'free_done'> | Of<'undo_done'> | null
}

export interface Cleanup {
  log: readonly CleanupEvent[]
  keys: Keys
  waiting: boolean
  started: Of<'started'> | null
  done: Of<'done'> | null
  free: Of<'free'> | null
  abandoned: Of<'abandoned'> | null
  job: Job | null
}

interface Seen {
  at: Map<string, number>
  size: number
}

const seenBy = new WeakMap<Keys, Seen>()
const extentOf = new WeakMap<Map<string, number>, number>()

function keysOf(at: Map<string, number>, size: number): Keys {
  const keys = {has: (key: string) => (at.get(key) ?? size) < size}
  seenBy.set(keys, {at, size})
  extentOf.set(at, size)
  return keys
}

function extended(keys: Keys, fresh: readonly string[]): Keys {
  const {at, size} = seenBy.get(keys) ?? {at: new Map<string, number>(), size: 0}
  const own = extentOf.get(at) === size ? at : new Map([...at].filter(([, index]) => index < size))
  fresh.forEach((key, offset) => own.set(key, size + offset))
  return keysOf(own, size + fresh.length)
}

export const NO_CLEANUP: Cleanup = {
  log: [],
  keys: keysOf(new Map(), 0),
  waiting: false,
  started: null,
  done: null,
  free: null,
  abandoned: null,
  job: null,
}

const TYPES: CleanupEvent['type'][] = [
  'waiting',
  'started',
  'removed',
  'held',
  'failed',
  'kept',
  'worktree',
  'command',
  'free',
  'done',
  'abandoned',
  'freed',
  'undone',
  'free_started',
  'free_done',
  'undo_started',
  'undo_done',
]
const SETTLING = new Set<CleanupEvent['type']>(['done', 'free_done', 'undo_done'])

function keyOf(event: CleanupEvent) {
  const data = event.data
  const job = 'job' in data ? `${event.type}:${data.job}` : ''
  if ('path' in data) return job ? `${job}:${data.path}` : data.path
  if (job) return job
  if (event.type === 'command') return `cmd:${event.data.id}`
  return event.type === 'free' ? `free:${event.data.elapsed_ms}` : event.type
}

function isNewRun(cleanup: Cleanup, event: CleanupEvent) {
  return event.type === 'started' && cleanup.started !== null && cleanup.started.run !== event.data.run
}

function absorbJob(cleanup: Cleanup, event: CleanupEvent): Cleanup {
  if (event.type === 'free_started' || event.type === 'undo_started') {
    return {...cleanup, job: {kind: event.type === 'free_started' ? 'free' : 'undo', id: event.data.job, count: event.data.count, bytes: event.data.bytes, done: null}}
  }
  const finished = (event.type === 'free_done' || event.type === 'undo_done') && cleanup.job?.id === event.data.job
  return finished && cleanup.job ? {...cleanup, job: {...cleanup.job, done: event.data}} : cleanup
}

function absorb(cleanup: Cleanup, event: CleanupEvent): Cleanup {
  switch (event.type) {
    case 'waiting':
      return {...cleanup, waiting: true}
    case 'started':
      return {...cleanup, started: event.data}
    case 'done':
      return {...cleanup, done: event.data}
    case 'abandoned':
      return {...cleanup, abandoned: event.data}
    case 'free':
      return event.data.elapsed_ms >= (cleanup.free?.elapsed_ms ?? 0) ? {...cleanup, free: event.data} : cleanup
    default:
      return absorbJob(cleanup, event)
  }
}

export function cleanupReducer(cleanup: Cleanup, events: readonly CleanupEvent[]): Cleanup {
  const keys = new Set<string>()
  const fresh: CleanupEvent[] = []
  let next = cleanup
  for (const [index, event] of events.entries()) {
    if (isNewRun(next, event)) return cleanupReducer(NO_CLEANUP, events.slice(index))
    const key = keyOf(event)
    if (cleanup.keys.has(key) || keys.has(key)) continue
    keys.add(key)
    fresh.push(event)
    next = absorb(next, event)
  }
  return fresh.length === 0 ? cleanup : {...next, log: cleanup.log.concat(fresh), keys: extended(cleanup.keys, [...keys])}
}

function isWorkerDone(type: CleanupEvent['type'], data: unknown) {
  return type !== 'done' || (typeof data === 'object' && data !== null && 'free_after' in data)
}

const CONNECTING = 0

function nothingLeft(type: CleanupEvent['type'], data: object) {
  if (type === 'abandoned') return true
  return SETTLING.has(type) && !('held' in data && typeof data.held === 'number' && data.held > 0)
}

function listenCleanup(source: EventSourceLike, take: (event: CleanupEvent) => void, setLost: (lost: boolean) => void) {
  for (const type of TYPES) {
    source.addEventListener(type, message => {
      const data = messageData(message)
      if (typeof data !== 'object' || data === null || !isWorkerDone(type, data)) return
      setLost(false)
      take({type, data} as CleanupEvent)
      if (nothingLeft(type, data)) source.close()
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
    const batch = perFrame(dispatch)
    const source = openEvents(`/events?token=${encodeURIComponent(token)}`)
    listenCleanup(source, batch.take, setLost)
    return () => {
      source.close()
      batch.stop()
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
  kind: 'removed' | 'failed' | 'kept' | 'ran' | 'held' | 'freed' | 'restored'
  id: string
  job: boolean
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

type Described = Omit<Outcome, 'at' | 'secs' | 'id' | 'job'>

const HELD_OUTCOME: Record<'freed' | 'restored' | 'kept', Outcome['kind']> = {freed: 'freed', restored: 'restored', kept: 'kept'}

function heldOutcome(plan: FilmPlan, event: Extract<CleanupEvent, {type: 'freed' | 'undone'}>): Described | null {
  const {outcome, path, bytes, reason} = event.data
  if (outcome === 'gone') return null
  return {kind: HELD_OUTCOME[outcome], key: path, reason, ...planned(plan, path, bytes)}
}

const PATH_KINDS: Partial<Record<CleanupEvent['type'], Outcome['kind']>> = {removed: 'removed', held: 'held', failed: 'failed', kept: 'kept'}

function commandOutcome(plan: FilmPlan, event: Extract<CleanupEvent, {type: 'command'}>): Described {
  const key = `cmd:${event.data.id}`
  const failed = event.data.status !== 'ok'
  return {kind: failed ? 'failed' : 'ran', key, reason: failed ? 'the command exited with an error' : '', ...planned(plan, key, 0, event.data.label)}
}

function worktreeKind(event: Extract<CleanupEvent, {type: 'worktree'}>): Outcome['kind'] {
  return event.data.outcome === 'kept' ? 'kept' : 'removed'
}

function described(plan: FilmPlan, event: CleanupEvent): Described | null {
  if (event.type === 'freed' || event.type === 'undone') return heldOutcome(plan, event)
  if (event.type === 'command') return commandOutcome(plan, event)
  const kind = event.type === 'worktree' ? worktreeKind(event) : PATH_KINDS[event.type]
  const data = event.data
  if (!kind || !('path' in data)) return null
  return {kind, key: data.path, reason: 'reason' in data ? data.reason : '', ...planned(plan, data.path, data.bytes)}
}

export function outcomeOf(plan: FilmPlan, event: CleanupEvent): Outcome | null {
  const outcome = described(plan, event)
  if (!outcome) return null
  return {
    ...outcome,
    id: keyOf(event),
    job: event.type === 'freed' || event.type === 'undone',
    at: 'elapsed_ms' in event.data ? event.data.elapsed_ms : 0,
    secs: event.type === 'removed' ? event.data.secs : 0,
  }
}

interface Derived {
  log: readonly CleanupEvent[]
  all: readonly Outcome[]
}

const derived = new WeakMap<FilmPlan, Derived>()

function extendsLog(known: readonly CleanupEvent[], log: readonly CleanupEvent[]) {
  const last = known.length - 1
  return known.length <= log.length && (last < 0 || (log[0] === known[0] && log[last] === known[last]))
}

export function outcomes(plan: FilmPlan, log: readonly CleanupEvent[]): readonly Outcome[] {
  const known = derived.get(plan)
  if (known?.log === log) return known.all
  const reuse = known && extendsLog(known.log, log) ? known : {log: [], all: []}
  const all = reuse.all.concat(log.slice(reuse.log.length).flatMap(e => outcomeOf(plan, e) ?? []))
  derived.set(plan, {log, all})
  return all
}

const NO_OUTCOMES: readonly Outcome[] = []

export function useOutcomes(plan: FilmPlan | null, log: readonly CleanupEvent[]) {
  return useMemo(() => (plan ? outcomes(plan, log) : NO_OUTCOMES), [plan, log])
}

export interface CleanupProgress {
  plan: FilmPlan
  cleanup: Cleanup
  outcomes: readonly Outcome[]
  byKey: ReadonlyMap<string, Outcome>
  freed: number
  held: number
  heldCount: number
  restored: number
  handled: number
  holdUntil: number | null
  count: number
  total: number
  free: number | null
  freeChange: number | null
}

const sum = (all: readonly Outcome[]) => all.reduce((total, o) => total + o.bytes, 0)
const FREED = new Set<Outcome['kind']>(['removed', 'freed'])
const LET_GO = new Set<Outcome['kind']>(['freed', 'restored'])

function removedBytes(all: readonly Outcome[]) {
  return sum(all.filter(o => FREED.has(o.kind)))
}

function stillHeld(all: readonly Outcome[], byKey: ReadonlyMap<string, Outcome>) {
  return all.filter(o => o.kind === 'held' && !LET_GO.has(byKey.get(o.key)?.kind ?? 'held'))
}

function jobProgress(cleanup: Cleanup, all: readonly Outcome[]) {
  const {job} = cleanup
  const prefix = job && `${job.kind === 'free' ? 'freed' : 'undone'}:${job.id}:`
  return prefix ? sum(all.filter(o => o.id.startsWith(prefix))) : 0
}

function freeNow({job, done, free, started}: Cleanup) {
  const afterJob = job?.done && 'free_after' in job.done ? job.done.free_after : undefined
  return [afterJob, done?.free_after, free?.free, started?.free].find(n => n !== undefined) ?? null
}

function totalOf(plan: FilmPlan, {started}: Cleanup) {
  return started ? started.paths + started.worktrees + (started.frees ?? 0) + started.commands : plan.items.size
}

function handledOf(cleanup: Cleanup, all: readonly Outcome[]) {
  if (cleanup.job && !cleanup.job.done) return jobProgress(cleanup, all)
  return sum(all.filter(o => !o.job && (o.kind === 'removed' || o.kind === 'held')))
}

function progressOf(plan: FilmPlan, cleanup: Cleanup, all: readonly Outcome[]): CleanupProgress {
  const {done} = cleanup
  const byKey = new Map(all.map(o => [o.key, o]))
  const latest = [...byKey.values()]
  const held = stillHeld(all, byKey)
  return {
    plan,
    cleanup,
    outcomes: all,
    byKey,
    freed: removedBytes(latest),
    held: sum(held),
    heldCount: held.length,
    restored: sum(latest.filter(o => o.kind === 'restored')),
    handled: handledOf(cleanup, all),
    holdUntil: done?.hold_until ?? null,
    count: all.filter(o => !o.job).length,
    total: totalOf(plan, cleanup),
    free: freeNow(cleanup),
    freeChange: done ? done.free_after - done.free_before : null,
  }
}

export type FreeOffer = 'offered' | 'refused' | 'waiting'

export function freeOffer(progress: CleanupProgress | null): FreeOffer {
  if (progress === null || progress.cleanup.abandoned) return 'refused'
  if (progress.cleanup.done === null || jobRunning(progress)) return 'waiting'
  return progress.held > 0 ? 'offered' : 'refused'
}

export function jobRunning(progress: CleanupProgress) {
  return progress.cleanup.job !== null && progress.cleanup.job.done === null
}

export function formatUntil(seconds: number | null) {
  if (seconds === null) return ''
  return new Date(seconds * 1000).toLocaleString(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})
}

export interface Totals {
  removed: Outcome[]
  held: Outcome[]
  failed: Outcome[]
  kept: Outcome[]
  sections: number
  biggest: Outcome | null
  reclaimed: number
  heldBytes: number
  seconds: number
}

export function totalsOf(all: readonly Outcome[], done: Of<'done'> | null): Totals {
  const byKey = new Map(all.map(o => [o.key, o]))
  const latest = [...byKey.values()]
  const removed = latest.filter(o => FREED.has(o.kind))
  const held = stillHeld(all, byKey)
  const cleared = [...removed, ...held]
  return {
    removed,
    held,
    failed: latest.filter(o => o.kind === 'failed'),
    kept: latest.filter(o => o.kind === 'kept'),
    sections: new Set(cleared.map(o => o.section)).size,
    biggest: cleared.reduce<Outcome | null>((best, o) => (best && best.bytes >= o.bytes ? best : o), null),
    reclaimed: removedBytes(removed),
    heldBytes: sum(held),
    seconds: Math.round((done?.elapsed_ms ?? Math.max(0, ...all.filter(o => !o.job).map(o => o.at))) / 1000),
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

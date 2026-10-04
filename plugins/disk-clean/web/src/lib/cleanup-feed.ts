import {ownedCollection, type Writes} from './owned'

type Timed<T> = T & {elapsed_ms: number}
type JobItem = {job: string; id: string; path: string; trashed_path: string; bytes: number; reason: string}
type JobCounts = {job: string; kept: number; trashed: number; trashed_bytes: number}

export type CleanupEvent =
  | {type: 'waiting'; data: object}
  | {type: 'started'; data: Timed<{run: string; free: number; paths: number; trash?: number; worktrees: number; commands: number; bytes: number}>}
  | {type: 'removed'; data: Timed<{path: string; bytes: number; secs: number}>}
  | {type: 'failed'; data: Timed<{path: string; bytes: number; reason: string}>}
  | {type: 'kept'; data: Timed<{path: string; bytes: number; reason: string}>}
  | {type: 'worktree'; data: Timed<{path: string; bytes: number; outcome: 'removed' | 'kept'; reason: string}>}
  | {type: 'command'; data: Timed<{id: string; label: string; status: 'ok' | 'failed'}>}
  | {type: 'free'; data: Timed<{free: number}>}
  | {type: 'trashed'; data: Timed<{id: string; path: string; bytes: number; trashed_path: string}>}
  | {type: 'done'; data: Timed<{free_before: number; free_after: number; trashed?: number; trashed_bytes?: number}>}
  | {type: 'abandoned'; data: {reason: string}}
  | {type: 'emptied'; data: Timed<JobItem & {outcome: 'emptied' | 'kept'}>}
  | {type: 'undone'; data: Timed<JobItem & {outcome: 'restored' | 'kept'}>}
  | {type: 'empty_started'; data: Timed<{job: string; count: number; bytes: number; free: number}>}
  | {type: 'empty_done'; data: Timed<JobCounts & {emptied: number; emptied_bytes: number; free_before: number; free_after: number}>}
  | {type: 'undo_started'; data: Timed<{job: string; count: number; bytes: number}>}
  | {type: 'undo_done'; data: Timed<JobCounts & {restored: number; restored_bytes: number}>}

export type Of<K extends CleanupEvent['type']> = Extract<CleanupEvent, {type: K}>['data']

export type OutcomeKind = 'removed' | 'failed' | 'kept' | 'ran' | 'trashed' | 'emptied' | 'restored'

export interface Planned {
  path: string
  label: string
  bytes: number
  section: string
  exact: boolean
}

export interface EventRow {
  id: string
  seq: number
  type: CleanupEvent['type']
  event: CleanupEvent
  kind: OutcomeKind | null
  key: string
  jobId: string
  job: boolean
  label: string
  bytes: number
  section: string
  reason: string
  at: number
  secs: number
  latest: boolean
}

interface Clock {
  id: 'clock'
  at: number
}

export const CLEANUP_TYPES: CleanupEvent['type'][] = [
  'waiting',
  'started',
  'removed',
  'trashed',
  'failed',
  'kept',
  'worktree',
  'command',
  'free',
  'done',
  'abandoned',
  'emptied',
  'undone',
  'empty_started',
  'empty_done',
  'undo_started',
  'undo_done',
]


export function isWorkerEvent(type: string, data: object) {
  return type !== 'done' || 'free_after' in data
}

export function nothingLeft({type}: {type: string}) {
  return type === 'abandoned'
}

function idOf(event: CleanupEvent) {
  const data = event.data
  if ('job' in data && 'path' in data) return `${data.job}:${data.path}`
  if ('job' in data) return data.job
  if ('path' in data) return data.path
  if (event.type === 'command') return event.data.id
  return event.type === 'free' ? String(event.data.elapsed_ms) : ''
}

type Described = Pick<EventRow, 'kind' | 'label' | 'reason'> & {path: string}

const NOTHING: Described = {kind: null, path: '', label: '', reason: ''}
const PATH_KINDS: Partial<Record<CleanupEvent['type'], OutcomeKind>> = {removed: 'removed', trashed: 'trashed', failed: 'failed', kept: 'kept'}

function jobOutcome(event: Extract<CleanupEvent, {type: 'emptied' | 'undone'}>): Described {
  const {outcome, path, reason} = event.data
  return {kind: outcome, path, label: path, reason}
}

function commandOutcome(event: Extract<CleanupEvent, {type: 'command'}>): Described {
  const failed = event.data.status !== 'ok'
  return {kind: failed ? 'failed' : 'ran', path: `cmd:${event.data.id}`, label: event.data.label, reason: failed ? 'the command exited with an error' : ''}
}

function describe(event: CleanupEvent): Described {
  if (event.type === 'emptied' || event.type === 'undone') return jobOutcome(event)
  if (event.type === 'command') return commandOutcome(event)
  const kind = event.type === 'worktree' ? (event.data.outcome === 'kept' ? 'kept' : 'removed') : PATH_KINDS[event.type]
  const data = event.data
  if (!kind || !('path' in data)) return NOTHING
  return {kind, path: data.path, label: data.path, reason: 'reason' in data ? data.reason : ''}
}

function numberIn(data: object, key: 'bytes' | 'elapsed_ms' | 'secs') {
  const value: unknown = key in data ? (data as Record<string, unknown>)[key] : 0
  return typeof value === 'number' ? value : 0
}

function plannedOf(planned: Planned | undefined, label: string, bytes: number) {
  if (!planned) return {label, bytes, section: ''}
  return {label: planned.label, bytes: planned.bytes, section: planned.section}
}

function rowOf(run: string, seq: number, event: CleanupEvent, plan: ReadonlyMap<string, Planned>): EventRow {
  const {data} = event
  const jobId = event.type === 'emptied' || event.type === 'undone' ? event.data.job : ''
  const {path, ...described} = describe(event)
  return {
    id: `${run}|${event.type}|${idOf(event)}`,
    seq,
    type: event.type,
    event,
    ...described,
    ...plannedOf(plan.get(path), described.label, numberIn(data, 'bytes')),
    key: path,
    jobId,
    job: jobId !== '',
    at: numberIn(data, 'elapsed_ms'),
    secs: event.type === 'removed' ? numberIn(data, 'secs') : 0,
    latest: described.kind !== null,
  }
}

export function createCleanupStore() {
  return {
    events: ownedCollection<EventRow>(row => row.id, []),
    clock: ownedCollection<Clock>(row => row.id, [{id: 'clock', at: 0}]),
    latest: new Map<string, string>(),
    run: '',
    seq: 0,
  }
}

export type CleanupStore = ReturnType<typeof createCleanupStore>

function isNewRun(store: CleanupStore, event: CleanupEvent) {
  return event.type === 'started' && store.run !== '' && store.run !== event.data.run
}

function supersede(store: CleanupStore, row: EventRow, writes: Writes<EventRow>) {
  if (row.kind === null) return
  const previous = store.events.synced.get(store.latest.get(row.key) ?? '')
  if (previous) writes.put({...previous, latest: false})
  store.latest.set(row.key, row.id)
}

function take(store: CleanupStore, event: CleanupEvent, plan: ReadonlyMap<string, Planned>, writes: Writes<EventRow>) {
  if (isNewRun(store, event)) {
    writes.clear()
    store.latest.clear()
  }
  if (event.type === 'started') store.run = event.data.run
  const row = rowOf(store.run, store.seq, event, plan)
  if (store.events.synced.has(row.id)) return 0
  store.seq += 1
  supersede(store, row, writes)
  writes.put(row)
  return row.at
}

export function receiveCleanup(store: CleanupStore, plan: ReadonlyMap<string, Planned>, events: readonly CleanupEvent[]) {
  let at = store.clock.synced.get('clock')?.at ?? 0
  store.events.write(writes => {
    for (const event of events) {
      if (isNewRun(store, event)) at = 0
      at = Math.max(at, take(store, event, plan, writes))
    }
  })
  if (at !== store.clock.synced.get('clock')?.at) store.clock.write(writes => writes.put({id: 'clock', at}))
}

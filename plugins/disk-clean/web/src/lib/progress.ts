import {useLiveQuery} from '@tanstack/react-db'
import {useMemo} from 'react'
import type {CleanupEvent, EventRow, Of, OutcomeKind} from './cleanup-feed'
import type {Db, Link, Planned} from './db'
import {useDisk, useSession} from './views'

export type LogRow = EventRow

export interface Outcome extends LogRow {
  kind: OutcomeKind
}

export interface Job {
  kind: 'free' | 'undo'
  id: string
  count: number
  bytes: number
  done: Of<'free_done'> | Of<'undo_done'> | null
}

export interface Cleanup {
  waiting: boolean
  started: Of<'started'> | null
  done: Of<'done'> | null
  free: Of<'free'> | null
  abandoned: Of<'abandoned'> | null
  job: Job | null
}

export interface PlannedSection {
  id: string
  title: string
  bytes: number
  count: number
}

export interface FilmPlan {
  items: ReadonlyMap<string, Planned>
  sections: PlannedSection[]
  approved: number
  total: number
  headline: ReadonlySet<string>
}

export interface Removal {
  bytes: number
  count: number
  restored: number
}

export interface CleanupProgress {
  plan: FilmPlan
  cleanup: Cleanup
  outcomes: readonly Outcome[]
  byKey: ReadonlyMap<string, Outcome>
  removals: ReadonlyMap<string, Removal>
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
  elapsed: number
  link: Link
}

interface Total {
  kind: OutcomeKind | null
  jobId: string
  bytes: number
  count: number
}

const NO_CLEANUP: Cleanup = {waiting: false, started: null, done: null, free: null, abandoned: null, job: null}

function withJob(cleanup: Cleanup, event: CleanupEvent): Cleanup {
  if (event.type === 'free_started' || event.type === 'undo_started') {
    return {...cleanup, job: {kind: event.type === 'free_started' ? 'free' : 'undo', id: event.data.job, count: event.data.count, bytes: event.data.bytes, done: null}}
  }
  const finished = (event.type === 'free_done' || event.type === 'undo_done') && cleanup.job?.id === event.data.job
  return finished && cleanup.job ? {...cleanup, job: {...cleanup.job, done: event.data}} : cleanup
}

function withStatus(cleanup: Cleanup, event: CleanupEvent): Cleanup {
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
      return withJob(cleanup, event)
  }
}

export function statusOf(events: readonly {event: CleanupEvent}[]) {
  return events.reduce((cleanup, row) => withStatus(cleanup, row.event), NO_CLEANUP)
}

export const isOutcome = <T extends {kind: OutcomeKind | null}>(row: T): row is T & {kind: OutcomeKind} => row.kind !== null

function sumOf(totals: readonly Total[], wanted: (total: Total) => boolean, field: 'bytes' | 'count' = 'bytes') {
  return totals.reduce((sum, total) => (wanted(total) ? sum + total[field] : sum), 0)
}

const FREED = new Set<OutcomeKind | null>(['removed', 'freed'])
const isHeld = (total: Total) => total.kind === 'held' || (total.kind === 'kept' && total.jobId !== '')

function handledOf(cleanup: Cleanup, totals: readonly Total[]) {
  const job = cleanup.job
  if (job && !job.done) return sumOf(totals, t => t.jobId === job.id)
  return sumOf(totals, t => t.jobId === '' && (t.kind === 'removed' || t.kind === 'held'))
}

function freeNow({job, done, free, started}: Cleanup) {
  const afterJob = job?.done && 'free_after' in job.done ? job.done.free_after : undefined
  return [afterJob, done?.free_after, free?.free, started?.free].find(n => n !== undefined) ?? null
}

function totalOf(plan: FilmPlan, {started}: Cleanup) {
  return started ? started.paths + started.worktrees + (started.frees ?? 0) + started.commands : plan.items.size
}

function removalsOf(rows: readonly {section: string; kind: OutcomeKind | null; bytes: number; count: number}[]) {
  const removals = new Map<string, Removal>()
  for (const row of rows) {
    const restored = row.kind === 'restored'
    if (!restored && row.kind !== 'removed' && row.kind !== 'held' && row.kind !== 'freed') continue
    const known = removals.get(row.section) ?? {bytes: 0, count: 0, restored: 0}
    removals.set(row.section, {bytes: known.bytes + row.bytes, count: known.count + (restored ? 0 : row.count), restored: known.restored + (restored ? row.count : 0)})
  }
  return removals
}

function usePlan(db: Db): FilmPlan {
  const {state: items} = useLiveQuery(db.plan.collection)
  const {data: sections} = useLiveQuery(db.queries.plannedSections)
  const {data: headline} = useLiveQuery(db.queries.headline)
  const {approvedBytes} = useSession(db)
  const {total} = useDisk(db)
  return useMemo(
    () => ({items, sections, approved: approvedBytes, total, headline: new Set(headline.map(h => h.path))}),
    [items, sections, approvedBytes, total, headline],
  )
}

function useCleanup(db: Db): Cleanup {
  const {data} = useLiveQuery(db.queries.status)
  return useMemo(() => statusOf(data), [data])
}

function useOutcomes(db: Db): readonly Outcome[] {
  const {data} = useLiveQuery(db.queries.outcomes)
  return useMemo(() => data.filter(isOutcome), [data])
}

export function useLatest(db: Db): readonly Outcome[] {
  const {data} = useLiveQuery(db.queries.latest)
  return useMemo(() => data.filter(isOutcome), [data])
}

function figuresOf(cleanup: Cleanup, totals: readonly Total[], latest: readonly Total[]) {
  return {
    freed: sumOf(latest, t => FREED.has(t.kind)),
    held: sumOf(latest, isHeld),
    heldCount: sumOf(latest, isHeld, 'count'),
    restored: sumOf(latest, t => t.kind === 'restored'),
    handled: handledOf(cleanup, totals),
    count: sumOf(totals, t => t.jobId === '', 'count'),
  }
}

function useFigures(db: Db, cleanup: Cleanup) {
  const {data: totals} = useLiveQuery(db.queries.totals)
  const {data: latest} = useLiveQuery(db.queries.latestTotals)
  const {data: bySection} = useLiveQuery(db.queries.bySection)
  const {data: clock} = useLiveQuery(db.cleanup.clock.collection)
  return useMemo(
    () => ({...figuresOf(cleanup, totals, latest), removals: removalsOf(bySection), elapsed: clock[0]?.at ?? 0}),
    [cleanup, totals, latest, bySection, clock],
  )
}

function useByKey(db: Db) {
  const latest = useLatest(db)
  return useMemo(() => new Map(latest.map(o => [o.key, o])), [latest])
}

export function useCleanupProgress(db: Db): CleanupProgress | null {
  const session = useSession(db)
  const plan = usePlan(db)
  const cleanup = useCleanup(db)
  const outcomes = useOutcomes(db)
  const byKey = useByKey(db)
  const figures = useFigures(db, cleanup)
  return useMemo(() => {
    if (!session.approved) return null
    const {done} = cleanup
    return {
      plan,
      cleanup,
      outcomes,
      byKey,
      ...figures,
      holdUntil: done?.hold_until ?? null,
      total: totalOf(plan, cleanup),
      free: freeNow(cleanup),
      freeChange: done ? done.free_after - done.free_before : null,
      link: session.cleanupLink,
    }
  }, [session, plan, cleanup, outcomes, byKey, figures])
}

export type FreeOffer = 'offered' | 'refused' | 'waiting'

export function jobRunning(progress: CleanupProgress) {
  return progress.cleanup.job !== null && progress.cleanup.job.done === null
}

export function freeOffer(progress: CleanupProgress | null): FreeOffer {
  if (progress === null || progress.cleanup.abandoned) return 'refused'
  if (progress.cleanup.done === null || jobRunning(progress)) return 'waiting'
  return progress.held > 0 ? 'offered' : 'refused'
}

export function resultOf(progress: CleanupProgress): 'held' | 'restored' | 'freed' {
  if (progress.held > 0) return 'held'
  return progress.restored > 0 ? 'restored' : 'freed'
}

export function resultBytes(progress: CleanupProgress) {
  const result = resultOf(progress)
  if (result === 'held') return progress.held
  return result === 'restored' ? progress.restored : progress.freed
}

export function formatUntil(seconds: number | null) {
  if (seconds === null) return ''
  return new Date(seconds * 1000).toLocaleString(undefined, {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'})
}

export function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60)
  return m > 0 ? `${m}m ${seconds % 60}s` : `${seconds}s`
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

const sum = (all: readonly Outcome[]) => all.reduce((total, o) => total + o.bytes, 0)
const isStillHeld = (o: Outcome) => o.kind === 'held' || (o.kind === 'kept' && o.job)

export function finaleOf(latest: readonly Outcome[], done: Of<'done'> | null, elapsed: number): Totals {
  const removed = latest.filter(o => FREED.has(o.kind))
  const held = latest.filter(isStillHeld)
  const cleared = [...removed, ...held]
  return {
    removed,
    held,
    failed: latest.filter(o => o.kind === 'failed'),
    kept: latest.filter(o => o.kind === 'kept'),
    sections: new Set(cleared.map(o => o.section)).size,
    biggest: cleared.reduce<Outcome | null>((best, o) => (best && best.bytes >= o.bytes ? best : o), null),
    reclaimed: sum(removed),
    heldBytes: sum(held),
    seconds: Math.round((done?.elapsed_ms ?? elapsed) / 1000),
  }
}

export interface MovieFeed {
  db: Db
  plan: FilmPlan
  cleanup: Cleanup
  elapsed: number
}

export function useMovie(db: Db): MovieFeed {
  const {data: clock} = useLiveQuery(db.cleanup.clock.collection)
  return {db, plan: usePlan(db), cleanup: useCleanup(db), elapsed: clock[0]?.at ?? 0}
}

export function useStaged(db: Db): readonly Outcome[] {
  const {data} = useLiveQuery(db.queries.staged)
  return useMemo(() => data.filter(isOutcome), [data])
}

const bySeq = (a: LogRow, b: LogRow) => a.seq - b.seq

export interface LogFeed {
  rows: readonly LogRow[]
  cleanup: () => Cleanup
  subscribe: (onChange: () => void) => () => void
}

function appendTo(rows: LogRow[], status: {cleanup: Cleanup}, added: readonly LogRow[]) {
  for (const row of added.toSorted(bySeq)) {
    rows.push(row)
    status.cleanup = withStatus(status.cleanup, row.event)
  }
}

export function logFeed(db: Db): LogFeed {
  const log = db.queries.log
  const rows: LogRow[] = []
  const status = {cleanup: NO_CLEANUP}
  const reread = () => {
    rows.length = 0
    status.cleanup = NO_CLEANUP
    appendTo(rows, status, log.toArray)
  }
  log.startSyncImmediate()
  reread()
  const subscribe = (onChange: () => void) => {
    if (log.size !== rows.length) reread()
    const subscription = log.subscribeChanges(changes => {
      if (changes.some(change => change.type === 'delete')) {
        rows.length = 0
        status.cleanup = NO_CLEANUP
      }
      appendTo(rows, status, changes.flatMap(change => (change.type === 'insert' ? [change.value] : [])))
      onChange()
    })
    return () => subscription.unsubscribe()
  }
  return {rows, cleanup: () => status.cleanup, subscribe}
}

import {createCollection} from '@tanstack/db'
import {QueryClient} from '@tanstack/query-core'
import {useRouteContext} from '@tanstack/react-router'
import {CLEANUP_TYPES, createCleanupStore, type Planned, isWorkerEvent, nothingLeft, receiveCleanup, type CleanupEvent} from './cleanup-feed'
import {outermost, sumBytes, type Loaded} from './data'
import {ownedCollection} from './owned'
import {createQueries} from './queries'
import {createScanStore, receiveScan, type Entry, type ScanEvent} from './scan-feed'
import {openEventSource, stream, type Listener} from './stream'

export type Link = 'live' | 'reconnecting' | 'lost'

export interface Session {
  id: 'session'
  approved: boolean
  approvedBytes: number
  cancelled: boolean
  scanLink: Link
  cleanupLink: Link
}

export type Action = 'approve' | 'cancel' | 'undo' | 'free' | 'rescan'

export interface Request {
  id: Action
  status: 'pending' | 'failed'
  message: string
}

const SCAN_TYPES: ScanEvent['type'][] = ['disk', 'progress', 'item', 'walked', 'done', 'error', 'rescan']
const FINAL = new Set<string>(['done', 'error'])
const CLOSED = 2

function planOf(items: readonly Entry[], approved: readonly string[] | undefined): Planned[] {
  if (!approved) return []
  const chosen = new Set(approved)
  return items.filter(i => chosen.has(i.path)).map(({path, label, bytes, section, exact}) => ({path, label, bytes, section, exact}))
}

function startSession(approved: boolean, approvedBytes: number): Session {
  return {id: 'session', approved, approvedBytes, cancelled: false, scanLink: 'live', cleanupLink: 'live'}
}

const linkOf = (state: number): Link => (state === CLOSED ? 'lost' : 'reconnecting')

function scanListener(setLink: (link: Link) => void): Listener<ScanEvent> {
  return {
    types: SCAN_TYPES,
    toEvent: (type, data) => ({type, data}) as ScanEvent,
    isFinal: event => FINAL.has(event.type),
    onDrop: state => {
      setLink(linkOf(state))
      return state === CLOSED ? {type: 'error', data: {message: 'Lost the connection to the scan', elapsed_ms: 0}} : null
    },
    onLive: () => setLink('live'),
  }
}

function cleanupListener(setLink: (link: Link) => void): Listener<CleanupEvent> {
  return {
    types: CLEANUP_TYPES,
    toEvent: (type, data) => (isWorkerEvent(type, data) ? ({type, data} as CleanupEvent) : null),
    isFinal: nothingLeft,
    onDrop: state => {
      setLink(linkOf(state))
      return null
    },
    onLive: () => setLink('live'),
  }
}

const bytesOf = (plan: readonly Planned[]) => sumBytes(outermost(plan).filter(p => p.exact))

function createBase(loaded: Loaded) {
  const scan = createScanStore(loaded)
  const cleanup = createCleanupStore()
  const plan = planOf([...scan.items.synced.values()], loaded.approved)
  const session = ownedCollection<Session>(s => s.id, [startSession(loaded.approved !== undefined, bytesOf(plan))])
  const planned = ownedCollection<Planned>(p => p.path, plan)
  return {
    loaded,
    scan,
    cleanup,
    plan: planned,
    session,
    requests: ownedCollection<Request>(r => r.id, []),
    queries: createQueries({items: scan.items.collection, events: cleanup.events.collection, plan: planned.collection, sections: scan.sections.collection}),
    streams: {scan: null as (() => void) | null, cleanup: null as (() => void) | null},
    queryClient: new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}}),
  }
}

type Base = ReturnType<typeof createBase>

function connectionOf(base: Base) {
  return createCollection<{id: string}, string>({
    getKey: row => row.id,
    gcTime: 100,
    sync: {
      sync: ({markReady}) => {
        markReady()
        return connect(base)
      },
    },
  })
}

export function createDb(loaded: Loaded) {
  const base = createBase(loaded)
  return {...base, connection: connectionOf(base)}
}

export type Db = ReturnType<typeof createDb>

const url = (db: Base) => `/events?token=${encodeURIComponent(db.loaded.token)}`
const opener = (db: Base) => () => (db.loaded.openEvents ?? openEventSource)(url(db))

export function receiveScanEvents(db: Base, events: readonly ScanEvent[]) {
  receiveScan(db.scan, events)
}

export function receiveCleanupEvents(db: Base, events: readonly CleanupEvent[]) {
  receiveCleanup(db.cleanup, db.plan.synced, events)
}

export function writeSession(db: Base, patch: Partial<Session>) {
  const current = db.session.synced.get('session')
  if (!current || Object.entries(patch).every(([key, value]) => current[key as keyof Session] === value)) return
  db.session.write(writes => writes.put({...current, ...patch}))
}

export function openScan(db: Base) {
  db.streams.scan?.()
  db.streams.scan = stream(opener(db), scanListener(scanLink => writeSession(db, {scanLink})), events => receiveScanEvents(db, events))
}

export function openCleanup(db: Base) {
  if (db.streams.cleanup) return
  db.streams.cleanup = stream(opener(db), cleanupListener(cleanupLink => writeSession(db, {cleanupLink})), events => receiveCleanupEvents(db, events))
}

function connect(db: Base) {
  if (db.loaded.live && !db.streams.scan) openScan(db)
  if (db.session.synced.get('session')?.approved) openCleanup(db)
  return () => {
    db.streams.scan?.()
    db.streams.cleanup?.()
    db.streams.scan = null
    db.streams.cleanup = null
  }
}

export function useDb() {
  return useRouteContext({from: '__root__', select: context => context.db})
}

export type {Planned}

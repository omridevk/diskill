import {isExact, type Category, type Insights, type Item, type Loaded, type ScanData, type TreeNode} from './data'

export interface Progress {
  files: number
  bytes: number
  dir: string
}

type CategoryHead = Omit<Category, 'items' | 'bytes'>

type Timed<T> = T & {elapsed_ms: number}

export type ScanEvent =
  | {type: 'disk'; data: Timed<{total: number; used: number; free: number; snapshots: number}>}
  | {type: 'progress'; data: Timed<Progress>}
  | {type: 'item'; data: Timed<{category: CategoryHead; item: Item}>}
  | {type: 'walked'; data: Timed<{home: number; tree: TreeNode | null; insights: Insights | null; worktrees: number}>}
  | {type: 'done'; data: Timed<{reclaimable: number}>}
  | {type: 'error'; data: Timed<{message: string}>}
  | {type: 'rescan'; data: Timed<object>}

export interface Scan {
  data: ScanData
  progress: Progress
  walked: boolean
  done: boolean
  error: string
  worktrees: number
  elapsed: number
  walkedAt: number
  rescans: number
  reported: ReadonlySet<string> | null
}

export function startScan(loaded: Loaded): Scan {
  const finished = !loaded.live
  return {
    data: loaded.data,
    progress: {files: 0, bytes: 0, dir: ''},
    walked: finished,
    done: finished,
    error: '',
    worktrees: 0,
    elapsed: 0,
    walkedAt: 0,
    rescans: 0,
    reported: null,
  }
}

const sum = (items: readonly Item[]) => items.reduce((total, i) => total + i.bytes, 0)

const byRiskThenSize = (a: Category, b: Category) => Number(a.risk === 'report') - Number(b.risk === 'report') || b.bytes - a.bytes

function reclaimableOf(categories: readonly Category[]) {
  return sum(categories.filter(c => c.risk !== 'report').flatMap(c => c.items.filter(isExact)))
}

type Found = {category: CategoryHead; item: Item}

function upsert(categories: readonly Category[], found: readonly Found[]): Category[] {
  const touched = new Map<string, {head: CategoryHead; items: Map<string, Item>}>()
  for (const {category, item} of found) {
    const known = touched.get(category.id) ?? {head: category, items: new Map((categories.find(c => c.id === category.id)?.items ?? []).map(i => [i.path, i]))}
    known.items.delete(item.path)
    known.items.set(item.path, item)
    touched.set(category.id, known)
  }
  const rebuilt = [...touched.values()].map(({head, items}) => {
    const sorted = [...items.values()].toSorted((a, b) => b.bytes - a.bytes)
    return {...(categories.find(c => c.id === head.id) ?? head), items: sorted, bytes: sum(sorted)}
  })
  return [...categories.filter(c => !touched.has(c.id)), ...rebuilt].toSorted(byRiskThenSize)
}

const withData = (scan: Scan, patch: Partial<ScanData>): Scan => ({...scan, data: {...scan.data, ...patch}})

function withItems(scan: Scan, found: readonly Found[]): Scan {
  const categories = upsert(scan.data.categories, found)
  const reported = scan.reported && new Set([...scan.reported, ...found.map(f => f.item.path)])
  return {...withData(scan, {categories, reclaimable: reclaimableOf(categories)}), reported}
}

function onlyReported(categories: readonly Category[], reported: ReadonlySet<string> | null) {
  if (!reported) return [...categories]
  return categories
    .map(c => {
      const items = c.items.filter(i => reported.has(i.path))
      return {...c, items, bytes: sum(items)}
    })
    .filter(c => c.items.length > 0)
}

type Handlers = {[K in ScanEvent['type']]: (scan: Scan, data: Extract<ScanEvent, {type: K}>['data']) => Scan}

const HANDLERS: Handlers = {
  disk: (scan, {total, used, free, snapshots}) => withData(scan, {total, used, free, snapshots}),
  progress: (scan, {files, bytes, dir}) => ({...scan, progress: {files, bytes, dir}}),
  item: (scan, found) => withItems(scan, [found]),
  walked: (scan, {home, tree, insights, worktrees, elapsed_ms}) => ({
    ...withData(scan, {home, tree, insights}),
    walked: true,
    worktrees,
    walkedAt: elapsed_ms,
  }),
  done: (scan, {reclaimable}) => ({
    ...withData(scan, {reclaimable, categories: onlyReported(scan.data.categories, scan.reported)}),
    done: true,
    reported: null,
  }),
  error: (scan, {message}) => ({...scan, error: message}),
  rescan: scan => ({
    ...scan,
    progress: {files: 0, bytes: 0, dir: ''},
    walked: false,
    done: false,
    error: '',
    worktrees: 0,
    elapsed: 0,
    walkedAt: 0,
    rescans: scan.rescans + 1,
    reported: new Set(),
  }),
}

export function scanReducer(scan: Scan, event: ScanEvent): Scan {
  const handle = HANDLERS[event.type] as (scan: Scan, data: ScanEvent['data']) => Scan
  const next = handle(scan, event.data)
  return {...next, elapsed: Math.max(next.elapsed, event.data.elapsed_ms)}
}

function foundIn(events: readonly ScanEvent[], from: number) {
  const found: Found[] = []
  let elapsed = 0
  for (let at = from; at < events.length; at++) {
    const event = events[at]
    if (event?.type !== 'item') break
    found.push(event.data)
    elapsed = Math.max(elapsed, event.data.elapsed_ms)
  }
  return {found, elapsed}
}

export function scanBatchReducer(scan: Scan, events: readonly ScanEvent[]): Scan {
  let next = scan
  for (let at = 0; at < events.length; ) {
    const event = events[at]
    if (!event) break
    if (event.type !== 'item') {
      next = scanReducer(next, event)
      at++
      continue
    }
    const {found, elapsed} = foundIn(events, at)
    next = {...withItems(next, found), elapsed: Math.max(next.elapsed, elapsed)}
    at += found.length
  }
  return next
}

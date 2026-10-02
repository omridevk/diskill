import {isExact, type Category, type Insights, type Item, type Loaded, type ScanData, type TreeNode} from './data'

export interface Progress {
  files: number
  bytes: number
  dir: string
}

type CategoryHead = Omit<Category, 'items' | 'bytes'>

export type ScanEvent =
  | {type: 'disk'; data: {total: number; used: number; free: number; snapshots: number}}
  | {type: 'progress'; data: Progress}
  | {type: 'item'; data: {category: CategoryHead; item: Item}}
  | {type: 'walked'; data: {home: number; tree: TreeNode | null; insights: Insights | null}}
  | {type: 'done'; data: {reclaimable: number}}
  | {type: 'error'; data: {message: string}}

export interface Scan {
  data: ScanData
  progress: Progress
  walked: boolean
  done: boolean
  error: string
}

export function startScan(loaded: Loaded): Scan {
  const finished = !loaded.live
  return {data: loaded.data, progress: {files: 0, bytes: 0, dir: ''}, walked: finished, done: finished, error: ''}
}

const sum = (items: readonly Item[]) => items.reduce((total, i) => total + i.bytes, 0)

const byRiskThenSize = (a: Category, b: Category) => Number(a.risk === 'report') - Number(b.risk === 'report') || b.bytes - a.bytes

function reclaimableOf(categories: readonly Category[]) {
  return sum(categories.filter(c => c.risk !== 'report').flatMap(c => c.items.filter(isExact)))
}

function upsert(categories: readonly Category[], head: CategoryHead, item: Item): Category[] {
  const current = categories.find(c => c.id === head.id) ?? {...head, items: [], bytes: 0}
  const items = [...current.items.filter(i => i.path !== item.path), item].toSorted((a, b) => b.bytes - a.bytes)
  return [...categories.filter(c => c.id !== head.id), {...current, items, bytes: sum(items)}].toSorted(byRiskThenSize)
}

const withData = (scan: Scan, patch: Partial<ScanData>): Scan => ({...scan, data: {...scan.data, ...patch}})

function withItem(scan: Scan, {category, item}: {category: CategoryHead; item: Item}) {
  const categories = upsert(scan.data.categories, category, item)
  return withData(scan, {categories, reclaimable: reclaimableOf(categories)})
}

type Handlers = {[K in ScanEvent['type']]: (scan: Scan, data: Extract<ScanEvent, {type: K}>['data']) => Scan}

const HANDLERS: Handlers = {
  disk: withData,
  progress: (scan, progress) => ({...scan, progress}),
  item: withItem,
  walked: (scan, walked) => ({...withData(scan, walked), walked: true}),
  done: (scan, {reclaimable}) => ({...withData(scan, {reclaimable}), done: true}),
  error: (scan, {message}) => ({...scan, error: message}),
}

export function scanReducer(scan: Scan, event: ScanEvent): Scan {
  const handle = HANDLERS[event.type] as (scan: Scan, data: ScanEvent['data']) => Scan
  return handle(scan, event.data)
}

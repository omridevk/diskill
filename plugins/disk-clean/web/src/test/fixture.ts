import {createMemoryHistory} from '@tanstack/react-router'
import type {Category, Item, Loaded, ScanData} from '@/lib/data'

const GB = 1024 ** 3

export const at = (url = '/') => createMemoryHistory({initialEntries: [url]})

export function item(path: string, bytes: number, extra: Partial<Item> = {}): Item {
  return {
    path,
    label: path.replace('/Users/you', '~'),
    bytes,
    action: 'rm',
    cmd_id: '-',
    note: '',
    age: 10,
    accuracy: 'exact',
    preselect: true,
    report: false,
    ...extra,
  }
}

export function category(id: string, title: string, risk: Category['risk'], items: Item[]): Category {
  return {id, title, desc: `${title} description`, risk, items, bytes: items.reduce((sum, i) => sum + i.bytes, 0)}
}

const categories: Category[] = [
  category('caches', 'Application caches', 'safe', [
    item('/Users/you/Library/Caches/app-a', 2 * GB),
    item('/Users/you/Library/Caches/app-b', 1 * GB, {age: 400}),
    item('/Users/you/Library/Caches/app-c', 0.5 * GB, {age: 120}),
    item('/Users/you/Library/Caches/app-d', 0.25 * GB, {age: 0}),
  ]),
  category('node', 'node_modules', 'safe', [
    item('/Users/you/code/web/node_modules', 3 * GB, {preselect: false, age: 2, note: 'pnpm project'}),
  ]),
  category('docker', 'Docker', 'review', [
    item('cmd:docker-prune', 5 * GB, {action: 'cmd', cmd_id: 'docker-prune', label: 'docker system prune -f', accuracy: 'vm', preselect: false, age: null}),
  ]),
  category('big', 'Large files', 'report', [item('/Users/you/big.iso', 8 * GB, {report: true, preselect: false})]),
]

const tree = {
  name: '~',
  path: '/Users/you',
  bytes: 40 * GB,
  files: 120_000,
  mtime: 1_700_000_000,
  children: [
    {
      name: 'Library',
      path: '/Users/you/Library',
      bytes: 25 * GB,
      files: 80_000,
      mtime: 1_700_000_000,
      children: [
        {name: 'Caches', path: '/Users/you/Library/Caches', bytes: 15 * GB, files: 50_000, mtime: 1_700_000_000, children: []},
        {name: 'everything else in this folder', path: '/Users/you/Library/*', bytes: 10 * GB, files: 30_000, mtime: 0, children: [], rest: true},
      ],
    },
    {name: 'code', path: '/Users/you/code', bytes: 15 * GB, files: 40_000, mtime: 1_690_000_000, children: []},
  ],
}

const data: ScanData = {
  categories,
  reclaimable: 6.75 * GB,
  free: 50 * GB,
  total: 500 * GB,
  used: 400 * GB,
  home: 40 * GB,
  snapshots: 2,
  tree,
  insights: {
    generated_at: 0,
    modified_by_day: [{day: '2026-01-01', bytes: 2 * GB, files: 10}],
    age_by_folder: {buckets: ['<1w', '<1m', 'older'], folders: [{path: '~/Library', bytes: [GB, 2 * GB, 3 * GB]}]},
    by_kind: [
      {kind: 'video', bytes: 4 * GB, files: 3},
      {kind: 'code', bytes: GB, files: 900},
    ],
    largest_files: [{path: '~/big.iso', bytes: 8 * GB, mtime: 1_700_000_000}],
  },
}

export const fixture: Loaded = {data, token: 'test-token', home: '/Users/you'}

export const cleanupEvents = [
  {type: 'waiting', data: {}},
  {type: 'started', data: {run: 'run-1', free: 50 * GB, paths: 4, worktrees: 1, commands: 0, bytes: 3.75 * GB, elapsed_ms: 0}},
  {type: 'removed', data: {path: '/Users/you/Library/Caches/app-a', bytes: 2 * GB, secs: 1, elapsed_ms: 900}},
  {type: 'free', data: {free: 52 * GB, elapsed_ms: 1000}},
  {type: 'removed', data: {path: '/Users/you/Library/Caches/app-b', bytes: GB, secs: 1, elapsed_ms: 1400}},
  {type: 'removed', data: {path: '/Users/you/Library/Caches/app-c', bytes: 0.5 * GB, secs: 1, elapsed_ms: 1500}},
  {type: 'failed', data: {path: '/Users/you/Library/Caches/app-d', bytes: 0.25 * GB, reason: 'still present after removal: permission denied', elapsed_ms: 1600}},
  {type: 'worktree', data: {path: '/Users/you/code/wt', bytes: GB, outcome: 'kept', reason: '1 uncommitted or untracked files', elapsed_ms: 2000}},
  {type: 'done', data: {free_before: 50 * GB, free_after: 53.4 * GB, elapsed_ms: 2500}},
] as const

export function bigSection(count: number): Category {
  const items = Array.from({length: count}, (_, i) =>
    item(`/Users/you/tmp/item-${String(i).padStart(5, '0')}`, 4096 + ((i * 7919) % 100_000), {age: i % 400, note: i % 3 === 0 ? 'temp file' : ''}),
  )
  return category('temp', 'Your macOS temp', 'safe', items)
}

export function withSection(extra: Category): Loaded {
  const [first, ...rest] = categories
  return {data: {...data, categories: first ? [first, extra, ...rest] : [extra]}, token: 'test-token', home: '/Users/you'}
}

const CACHES = ['app-a', 'app-b', 'app-c', 'app-d'].map((name, i) => ({path: `/Users/you/Library/Caches/${name}`, bytes: [2, 1, 0.5, 0.25][i]! * GB}))

const HOLD_UNTIL = 1_800_000_000

export const heldEvents = [
  {type: 'started', data: {run: 'run-h', free: 50 * GB, paths: 4, worktrees: 1, commands: 0, bytes: 4.75 * GB, elapsed_ms: 0}},
  ...CACHES.map((c, i) => ({type: 'held', data: {...c, held_path: `/Users/you/.cache/disk-clean/held/run-h/${i + 1}`, elapsed_ms: 100 + i}})),
  {type: 'worktree', data: {path: '/Users/you/code/wt', bytes: GB, outcome: 'removed', reason: '', elapsed_ms: 900}},
  {type: 'done', data: {removed: 1, removed_bytes: GB, held: 4, held_bytes: 3.75 * GB, hold_until: HOLD_UNTIL, free_before: 50 * GB, free_after: 51 * GB, elapsed_ms: 1000}},
] as const

const item_of = (job: string, c: (typeof CACHES)[number], i: number, outcome: string) => ({
  job,
  ...c,
  held_path: `/Users/you/.cache/disk-clean/held/run-h/${i + 1}`,
  outcome,
  reason: '',
  elapsed_ms: 10 + i,
})

export const undoEvents = [
  {type: 'undo_started', data: {job: 'j-undo', count: 4, bytes: 3.75 * GB, elapsed_ms: 0}},
  ...CACHES.map((c, i) => ({type: 'undone', data: item_of('j-undo', c, i, 'restored')})),
  {type: 'undo_done', data: {job: 'j-undo', restored: 4, restored_bytes: 3.75 * GB, kept: 0, held: 0, held_bytes: 0, elapsed_ms: 50}},
] as const

export const freeEvents = [
  {type: 'free_started', data: {job: 'j-free', count: 4, bytes: 3.75 * GB, free: 51 * GB, elapsed_ms: 0}},
  ...CACHES.map((c, i) => ({type: 'freed', data: item_of('j-free', c, i, 'freed')})),
  {type: 'free_done', data: {job: 'j-free', freed: 4, freed_bytes: 3.75 * GB, kept: 0, held: 0, held_bytes: 0, free_before: 51 * GB, free_after: 54.75 * GB, elapsed_ms: 80}},
] as const

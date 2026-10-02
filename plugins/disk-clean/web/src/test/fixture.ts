import type {Category, Item, Loaded, ScanData} from '@/lib/data'

const GB = 1024 ** 3

function item(path: string, bytes: number, extra: Partial<Item> = {}): Item {
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

function category(id: string, title: string, risk: Category['risk'], items: Item[]): Category {
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
  children: [
    {
      name: 'Library',
      path: '/Users/you/Library',
      bytes: 25 * GB,
      children: [
        {name: 'Caches', path: '/Users/you/Library/Caches', bytes: 15 * GB, children: []},
        {name: 'everything else in this folder', path: '/Users/you/Library/*', bytes: 10 * GB, children: [], rest: true},
      ],
    },
    {name: 'code', path: '/Users/you/code', bytes: 15 * GB, children: []},
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

export const fixture: Loaded = {data, token: 'test-token'}

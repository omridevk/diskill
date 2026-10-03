import {hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode} from 'd3-hierarchy'
import {useState} from 'react'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {cdp, page, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {ActionBar} from './components/action-bar'
import {PreviewDialog} from './components/preview-dialog'
import {gsap} from 'gsap'
import {cleanupReducer, filmPlan, NO_CLEANUP, outcomes, totalsOf, type CleanupEvent} from './lib/cleanup'
import {formatBytes, NO_DATA, type Category, type Loaded} from './lib/data'
import {cssMs, useTextSwap} from './lib/motion'
import {scanBatchReducer, scanReducer, startScan, type ScanEvent} from './lib/scan'
import {NO_PICKS, outermost, picksReducer, useSelection} from './lib/selection'
import {squarifyInBounds} from './lib/treemap-tile'
import {category, cleanupEvents, fixture, item} from './test/fixture'
import './index.css'

describe('formatBytes', () => {
  test('picks the unit and precision', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(250 * 1024 ** 3)).toBe('250 GB')
  })
})

describe('motion tokens', () => {
  test('durations read in milliseconds whether written in ms or s', () => {
    const root = document.documentElement
    root.style.setProperty('--test-ms', '150ms')
    root.style.setProperty('--test-s', '.25s')
    expect([cssMs('--test-ms', 0), cssMs('--test-s', 0), cssMs('--test-missing', 42)]).toEqual([150, 250, 42])
    root.style.removeProperty('--test-ms')
    root.style.removeProperty('--test-s')
  })
})

describe('cleanup', () => {
  test('preselected items set the total and footer', async () => {
    const screen = await render(<App loaded={fixture} />)
    await expect.element(screen.getByText('4 items selected · 3.8 GB')).toBeVisible()
    await expect.element(screen.getByText('3.8 GB', {exact: true}).first()).toBeVisible()
  })

  test('a section checkbox selects every item in it', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('checkbox', {name: 'Select all in node_modules'}).click()
    await expect.element(screen.getByText('5 items selected · 6.8 GB')).toBeVisible()
  })

  test('unticking one item makes its section partly selected', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByText('~/Library/Caches/app-a').click()
    await expect
      .element(screen.getByRole('checkbox', {name: 'Select all in Application caches'}))
      .toHaveAttribute('aria-checked', 'mixed')
    await expect.element(screen.getByText('3 items selected · 1.8 GB')).toBeVisible()
  })

  test('quick select keeps only items idle a year or more', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('button', {name: 'idle 1+ year'}).click()
    await expect.element(screen.getByText('1 item selected · 1.0 GB')).toBeVisible()
  })

  test('filtering hides selected items and warns about them', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('app-a')
    await expect.element(screen.getByText(/3 selected items are hidden by the filters/)).toBeVisible()
    await expect.element(screen.getByText('~/Library/Caches/app-b')).not.toBeInTheDocument()
  })

  test('a filter that matches nothing offers to clear it', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('no such path')
    await screen.getByRole('button', {name: 'Clear filters'}).click()
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()
  })

  test('card view shows every section and opens one in the list', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('button', {name: 'Card view'}).click()
    await expect.element(screen.getByText('Large files')).toBeVisible()
    await screen.getByRole('button', {name: /Show items/}).nth(1).click()
    await expect.element(screen.getByText('~/code/web/node_modules')).toBeVisible()
  })

  test('keyboard shortcuts select all, clear and reset', async () => {
    const screen = await render(<App loaded={fixture} />)
    await userEvent.keyboard('d')
    await expect.element(screen.getByText('0 items selected · 0 B')).toBeVisible()
    await userEvent.keyboard('r')
    await expect.element(screen.getByText('4 items selected · 3.8 GB')).toBeVisible()
  })
})

describe('other tabs', () => {
  test('storage shows the folder tree, reconciliation and snapshots', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('tab', {name: 'Storage'}).click()
    await expect.element(screen.getByText('Where your 500 GB went')).toBeVisible()
    await expect.element(screen.getByText(/2 local Time Machine snapshots/)).toBeVisible()
    await screen.getByRole('button', {name: 'Treemap'}).click()
    await expect.element(screen.getByLabelText(/Storage treemap/)).toBeVisible()
  })

  test('hovering the sunburst shows a folder card with its path, shares, files and cleanable bytes', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('tab', {name: 'Storage'}).click()
    const chart = screen.getByLabelText(/Storage sunburst/)
    await expect.element(chart).toBeVisible()
    await userEvent.hover(chart, {position: ringPoints(chart.element())(0.3125, 0).local})
    await expect.element(page.getByText('~/Library', {exact: true})).toBeVisible()
    await expect.element(page.getByText('of Home folder')).toBeVisible()
    await expect.element(page.getByText('of the disk')).toBeVisible()
    await expect.element(page.getByText(/^80,000 files · changed /)).toBeVisible()
    await expect.element(page.getByText('3.8 GB cleanable in 4 items · 3.8 GB selected')).toBeVisible()
    await expect.element(page.getByText('Click to zoom')).toBeVisible()
    await expect.element(page.getByText(/apparent sizes|^x /)).not.toBeInTheDocument()
  })

  test('hovering a sunburst slice lights it and its ancestors, dims the rest, and the card names only that slice', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('tab', {name: 'Storage'}).click()
    const chart = screen.getByLabelText(/Storage sunburst/)
    await expect.element(chart).toBeVisible()
    const at = ringPoints(chart.element())
    const caches = at(0.1875, 1)
    await userEvent.hover(chart, {position: caches.local})
    await expect.element(page.getByText('~/Library/Caches', {exact: true})).toBeVisible()
    await expect.element(page.getByText('of Library')).toBeVisible()
    await expect.element(page.getByText('~/Library', {exact: true})).not.toBeInTheDocument()
    await settle(cssMs('--duration-fast', 250) * 3)
    expect(paintedOpacity(caches.client)).toBe(1)
    expect(paintedOpacity(at(0.3125, 0).client)).toBe(1)
    expect(paintedOpacity(at(0.5, 1).client)).toBeCloseTo(0.28)
    expect(paintedOpacity(at(0.8125, 0).client)).toBeCloseTo(0.28)
  })

  test('hovering the disk donut names the segment with its size and share of the disk', async () => {
    const screen = await render(<App loaded={fixture} />)
    const donut = screen.getByLabelText(/^Disk: /)
    const free = [...donut.element().querySelectorAll('path')].at(-1)
    if (!free) throw new Error('the donut drew no slices')
    await userEvent.hover(page.elementLocator(free))
    await expect.element(page.getByText('Free right now')).toBeVisible()
    await expect.element(page.getByText('10.0%')).toBeVisible()
  })

  test('insights draws every panel', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('tab', {name: 'Insights'}).click()
    for (const title of ['When your files last changed', 'How old each big folder is', 'What kind of data', 'Cleanup sections by idle time', 'Largest files']) {
      await expect.element(screen.getByText(title)).toBeVisible()
    }
    await expect.element(page.getByText('This chart could not be drawn')).not.toBeInTheDocument()
    const kinds = screen.getByLabelText('Bytes by file kind')
    await expect.element(kinds.getByText(/^\d+(\.\d)? [KMG]B$/).first()).toBeVisible()
    await expect.element(kinds.getByText(/^[\d,.]{7,}$/)).not.toBeInTheDocument()
  })
})

describe('preview dialog', () => {
  const plan = {
    commands: [
      'rm -rf -- /Users/you/Library/Caches/app-a',
      'git -C /Users/you/repo worktree remove /Users/you/repo-wt',
      'git -C /Users/you/repo worktree prune',
      'docker system prune -f',
    ],
    rejected: [{reason: 'already gone', path: '/Users/you/old'}],
    count: 3,
    bytes: 2 * 1024 ** 3,
  }

  test('counts each kind of command and lists rejections', async () => {
    const screen = await render(<PreviewDialog plan={plan} open onOpenChange={() => {}} onApprove={() => {}} />)
    await expect.element(screen.getByText('folders deleted')).toBeVisible()
    await expect.element(screen.getByText('/Users/you/Library/Caches/app-a')).toBeVisible()
    await screen.getByRole('tab', {name: /Rejected/}).click()
    await expect.element(screen.getByText('/Users/you/old')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Approve and delete 2.0 GB'})).toBeEnabled()
  })
})

describe('treemap tiling', () => {
  interface Tile {
    value?: number
    children?: Tile[]
  }
  const WIDTH = 1131.5
  const HEIGHT = 480
  const layout = (tile: (node: HierarchyRectangularNode<Tile>, x0: number, y0: number, x1: number, y1: number) => void) =>
    treemap<Tile>().size([WIDTH, HEIGHT]).tile(tile)(hierarchy<Tile>({children: [{value: 758}, {value: 515}]}).sum(d => d.value ?? 0))
  const outside = (root: HierarchyRectangularNode<Tile>) => root.descendants().filter(n => n.x0 < 0 || n.y0 < 0 || n.x1 > WIDTH || n.y1 > HEIGHT)

  test('plain d3 squarify overshoots the container by float error', () => {
    expect(outside(layout(treemapSquarify))).not.toHaveLength(0)
  })

  test('the clamped tiler keeps every tile inside the container', () => {
    expect(outside(layout(squarifyInBounds))).toHaveLength(0)
  })
})

const GB = 1024 ** 3
const LIVE: Loaded = {data: NO_DATA, token: 'test-token', live: true}

function itemEvents(categories: Category[]): ScanEvent[] {
  return categories
    .flatMap(c => c.items)
    .map((item, i) => ({type: 'item' as const, data: {category: categoryOf(item.path), item, elapsed_ms: 500 + i * 100}}))
}

function categoryOf(path: string) {
  const found = fixture.data.categories.find(c => c.items.some(i => i.path === path))
  if (!found) throw new Error(`no category for ${path}`)
  return {id: found.id, title: found.title, desc: found.desc, risk: found.risk}
}

const disk: ScanEvent = {type: 'disk', data: {total: 500 * GB, used: 400 * GB, free: 50 * GB, snapshots: 2, elapsed_ms: 20}}
const walked: ScanEvent = {
  type: 'walked',
  data: {home: 40 * GB, tree: fixture.data.tree, insights: fixture.data.insights ?? null, worktrees: 3, elapsed_ms: 4000},
}
const done: ScanEvent = {type: 'done', data: {reclaimable: 7 * GB, elapsed_ms: 9500}}
const items = itemEvents(fixture.data.categories)
const fold = (events: ScanEvent[]) => events.reduce(scanReducer, startScan(LIVE))
const itemsOf = (events: ScanEvent[]) => fold(events).data.categories.flatMap(c => c.items)

describe('live scan reducer', () => {
  test('items land in their categories, ordered by risk then size like the server', () => {
    const scan = fold([disk, ...items.toReversed()])
    expect(scan.data.categories.map(c => c.id)).toEqual(['docker', 'caches', 'node', 'big'])
    expect(scan.data.categories.find(c => c.id === 'caches')?.items.map(i => i.label)).toEqual([
      '~/Library/Caches/app-a',
      '~/Library/Caches/app-b',
      '~/Library/Caches/app-c',
      '~/Library/Caches/app-d',
    ])
    expect(scan.data.reclaimable).toBe(6.75 * GB)
    expect([scan.data.total, scan.data.free, scan.walked, scan.done]).toEqual([500 * GB, 50 * GB, false, false])
  })

  test('a replay of every event leaves the state unchanged', () => {
    const events = [disk, ...items, walked, done]
    expect(fold([...events, ...events])).toEqual(fold(events))
  })

  test('walked, done and error each set their part, and elapsed tracks the scan clock', () => {
    const scan = fold([disk, ...items, walked, done])
    expect([scan.walked, scan.done, scan.data.home, scan.data.reclaimable, scan.data.tree?.name]).toEqual([true, true, 40 * GB, 7 * GB, '~'])
    expect([scan.worktrees, scan.walkedAt, scan.elapsed]).toEqual([3, 4000, 9500])
    expect(scan.data).not.toHaveProperty('elapsed_ms')
    expect(scan.data).not.toHaveProperty('worktrees')
    expect(fold([disk, {type: 'error', data: {message: 'walk failed', elapsed_ms: 30}}]).error).toBe('walk failed')
  })

  test('a burst of events applied in one pass lands in the same state as one at a time', () => {
    const rescan: ScanEvent = {type: 'rescan', data: {elapsed_ms: 0}}
    const events = [disk, ...items, walked, rescan, ...items.toReversed(), ...items, done]
    expect(scanBatchReducer(startScan(LIVE), events)).toEqual(fold(events))
  })

  test('a finished run starts walked and done', () => {
    expect(startScan(fixture)).toMatchObject({walked: true, done: true, data: fixture.data})
  })

  test('preselected items are selected when they arrive, and an unticked one stays unticked on replay', () => {
    const appA = items[0]?.type === 'item' ? items[0].data.item : undefined
    if (!appA) throw new Error('fixture has no first item')
    const first = picksReducer(NO_PICKS, {type: 'offer', items: itemsOf(items.slice(0, 2))})
    expect(Object.keys(first.on)).toEqual(['/Users/you/Library/Caches/app-a', '/Users/you/Library/Caches/app-b'])
    const {[appA.path]: _untick, ...rest} = first.on
    const unticked = picksReducer(first, {type: 'select', update: rest})
    const replayed = picksReducer(unticked, {type: 'offer', items: itemsOf([...items, ...items])})
    expect(replayed.on[appA.path]).toBeUndefined()
    expect(replayed.on['/Users/you/Library/Caches/app-d']).toBe(true)
    expect(replayed.on['/Users/you/code/web/node_modules']).toBeUndefined()
  })
})

const SHOWN = {visibility: 'visible'}

function fakeEventSource() {
  const source = Object.assign(new EventTarget(), {
    readyState: 1,
    close: () => {
      source.readyState = 2
    },
  })
  const send = (event: ScanEvent) => source.dispatchEvent(new MessageEvent(event.type, {data: JSON.stringify(event.data)}))
  return {source, send}
}

describe('live page', () => {
  beforeEach(() => document.documentElement.style.setProperty('--fuse-window', '300ms'))
  afterEach(() => document.documentElement.style.removeProperty('--fuse-window'))

  test('streams items during the walk, reveals storage on walked, unlocks on done and undoes an approve', async () => {
    const {source, send} = fakeEventSource()
    const screen = await render(<App loaded={{...LIVE, openEvents: () => source}} />)
    await expect.element(screen.getByText('Scanning your disk…').first().first()).toBeInTheDocument()
    await expect.element(screen.getByText('Walking disk')).toBeVisible()
    send({type: 'progress', data: {files: 1234, bytes: 5 * GB, dir: '/Users/you/Library/Caches', elapsed_ms: 300}})
    await expect.element(screen.getByText('1,234 files · 5.0 GB')).toBeVisible()
    for (const event of [disk, ...items.slice(0, 5)]) send(event)
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()
    await screen.getByRole('tab', {name: 'Storage'}).click()
    await expect.element(screen.getByText(/^Where your/)).not.toBeInTheDocument()
    await expect.element(screen.getByText('Scanning your disk…').first()).toBeInTheDocument()
    send(walked)
    await expect.element(screen.getByText('Scanning your disk…').first()).not.toBeInTheDocument()
    await expect.element(screen.getByText('4 items selected · 3.8 GB')).toBeVisible()
    await expect.element(screen.getByText('Where your 500 GB went')).toBeVisible()
    await expect.element(screen.getByText('Checking 3 worktrees')).toBeVisible()
    await screen.getByRole('tab', {name: 'Cleanup'}).click()
    await expect.element(screen.getByText(/Preview and Approve unlock when the scan finishes/)).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Approve and delete'})).toBeDisabled()
    await expect.element(screen.getByRole('button', {name: 'Preview commands'})).toBeDisabled()
    for (const event of items.slice(5)) send(event)
    await expect.element(screen.getByRole('button', {name: /^Docker/})).toBeVisible()
    send(done)
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await expect.element(screen.getByText('9.5s')).toBeVisible()
    await screen.getByRole('button', {name: 'Approve and delete'}).click()
    await expect.element(screen.getByRole('button', {name: 'Undo'})).toHaveStyle(SHOWN)
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('button', {name: 'Approve and delete'})).toHaveStyle(SHOWN)
    await expect.element(screen.getByText(/approved for deletion/)).not.toBeInTheDocument()
  })

  test('rescan keeps the view, filters and picks, and replaces the results at done', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Response('{}', {status: 202}))
    const sources: ReturnType<typeof fakeEventSource>[] = []
    const openEvents = () => {
      const fake = fakeEventSource()
      sources.push(fake)
      return fake.source
    }
    const send = (event: ScanEvent) => sources.at(-1)?.send(event)
    const screen = await render(<App loaded={{...LIVE, openEvents}} />)
    for (const event of [disk, ...items, walked, done]) send(event)
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await screen.getByText('~/Library/Caches/app-a').click()
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('Library')
    await screen.getByRole('button', {name: 'Card view'}).click()
    await expect.element(screen.getByText('3 items selected · 1.8 GB')).toBeVisible()

    await screen.getByRole('button', {name: 'Rescan'}).click()
    await expect.element(screen.getByText('Rescanning')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Rescan'})).toBeDisabled()
    await expect.element(screen.getByRole('button', {name: 'Approve and delete'})).toBeDisabled()
    await expect.element(screen.getByText('Scanning your disk…')).not.toBeInTheDocument()
    expect(window.fetch).toHaveBeenCalledWith('/rescan', expect.objectContaining({body: JSON.stringify({token: 'test-token'})}))
    await expect.poll(() => sources.length).toBe(2)
    const appE = {...fixture.data.categories[0]!.items[0]!, path: '/Users/you/Library/Caches/app-e', label: '~/Library/Caches/app-e', bytes: GB}
    const rescanned = items.filter(e => e.type !== 'item' || e.data.item.path !== '/Users/you/Library/Caches/app-d')
    send({type: 'rescan', data: {elapsed_ms: 0}})
    for (const event of [disk, ...rescanned, {type: 'item', data: {category: categoryOf(fixture.data.categories[0]!.items[0]!.path), item: appE, elapsed_ms: 900}} as const, walked]) send(event)
    await expect.element(screen.getByText('Checking 3 worktrees')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Approve and delete'})).toBeDisabled()
    send(done)
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Card view'})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(screen.getByRole('textbox', {name: 'Filter paths'})).toHaveValue('Library')
    await screen.getByRole('button', {name: 'List view'}).click()
    await expect.element(screen.getByText('~/Library/Caches/app-d')).not.toBeInTheDocument()
    await expect.element(screen.getByRole('checkbox', {name: /app-e/})).toBeChecked()
    await expect.element(screen.getByRole('checkbox', {name: /app-a/})).not.toBeChecked()
    await expect.element(screen.getByText('3 items selected · 2.5 GB')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Approve and delete'})).toBeEnabled()

    await screen.getByRole('tab', {name: 'Storage'}).click()
    await screen.getByRole('button', {name: 'Treemap'}).click()
    await screen.getByRole('button', {name: 'Rescan'}).click()
    await expect.poll(() => sources.length).toBe(3)
    for (const event of [{type: 'rescan', data: {elapsed_ms: 0}} as const, disk, ...rescanned, walked, done]) send(event)
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await expect.element(screen.getByRole('tab', {name: 'Storage'})).toHaveAttribute('aria-selected', 'true')
    await expect.element(screen.getByRole('button', {name: 'Treemap'})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(screen.getByText('2 items selected · 1.5 GB')).toBeVisible()
    vi.restoreAllMocks()
  })

  test('a scan error shows and keeps approve locked', async () => {
    const {source, send} = fakeEventSource()
    const screen = await render(<App loaded={{...LIVE, openEvents: () => source}} />)
    send(disk)
    send({type: 'error', data: {message: 'permission denied', elapsed_ms: 40}})
    await expect.element(screen.getByText(/The scan failed: permission denied/)).toBeVisible()
    await expect.element(screen.getByText('Scan failed')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Approve and delete'})).toBeDisabled()
  })
})

function Bar() {
  const selection = useSelection(fixture.data.categories)
  const [approved, setApproved] = useState(0)
  return (
    <>
      <output>{approved} approved</output>
      <ActionBar selection={selection} locked={false} previewing={false} onCancel={() => {}} onPreview={() => {}} onApprove={() => setApproved(n => n + 1)} />
    </>
  )
}

describe('approve fuse', () => {
  beforeEach(() => document.documentElement.style.setProperty('--fuse-window', '300ms'))
  afterEach(() => document.documentElement.style.removeProperty('--fuse-window'))

  test('approves only when the fuse runs out, and an undone press never approves', async () => {
    const screen = await render(<Bar />)
    const approve = screen.getByRole('button', {name: 'Approve and delete'})
    const undo = screen.getByRole('button', {name: 'Undo'})
    await approve.click()
    await expect.element(undo).toHaveStyle(SHOWN)
    await undo.click()
    await expect.element(approve).toHaveStyle(SHOWN)
    await expect.element(screen.getByText('0 approved')).toBeVisible()
    await approve.click()
    await expect.element(undo).toHaveStyle(SHOWN)
    await expect.element(screen.getByText('1 approved')).toBeVisible()
    await expect.element(approve).toHaveStyle(SHOWN)
    await expect.element(screen.getByText('1 approved')).toBeVisible()
  })
})

const backdrop = (container: HTMLElement) => container.querySelector('.t-backdrop canvas')

function emulateReducedMotion(value: 'reduce' | 'no-preference') {
  return cdp().send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value}]})
}

function frameOf(canvas: Element | null | undefined) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no canvas')
  return canvas.toDataURL()
}

function ringPoints(chart: Element) {
  const sectors = [...chart.querySelectorAll('.storage-base path')].map(p => p.getBoundingClientRect())
  const right = Math.max(...sectors.map(r => r.right))
  const top = Math.min(...sectors.map(r => r.top))
  const bottom = Math.max(...sectors.map(r => r.bottom))
  const radius = (bottom - top) / 2
  const box = chart.getBoundingClientRect()
  return (turn: number, ring: number) => {
    const distance = radius * (0.28 + 0.36 * (ring + 0.5))
    const x = right - radius + distance * Math.sin(turn * 2 * Math.PI)
    const y = (top + bottom) / 2 - distance * Math.cos(turn * 2 * Math.PI)
    return {client: {x, y}, local: {x: x - box.left, y: y - box.top}}
  }
}

function paintedOpacity({x, y}: {x: number; y: number}) {
  let opacity = 1
  for (let node = document.elementFromPoint(x, y); node && node.tagName !== 'svg'; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
  return opacity
}

function settle(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('effects', () => {
  beforeEach(() => document.documentElement.style.setProperty('--fuse-window', '300ms'))
  afterEach(async () => {
    document.documentElement.style.removeProperty('--fuse-window')
    vi.restoreAllMocks()
    await emulateReducedMotion('no-preference')
  })

  test('the flow field backdrop runs behind the summary while walking and leaves after walked', async () => {
    const {source, send} = fakeEventSource()
    const screen = await render(<App loaded={{...LIVE, openEvents: () => source}} />)
    send(disk)
    await expect.poll(() => backdrop(screen.container)).toBeInstanceOf(HTMLCanvasElement)
    send(walked)
    await expect.element(screen.getByText('Checking 3 worktrees')).toBeVisible()
    await expect.poll(() => backdrop(screen.container)).toBeNull()
  })

  test('reduced motion draws one still frame of each effect', async () => {
    await emulateReducedMotion('reduce')
    const {source, send} = fakeEventSource()
    const live = await render(<App loaded={{...LIVE, openEvents: () => source}} />)
    send(disk)
    await expect.poll(() => backdrop(live.container)).toBeInstanceOf(HTMLCanvasElement)
    const scanFrame = frameOf(backdrop(live.container))
    await settle(300)
    expect(frameOf(backdrop(live.container))).toBe(scanFrame)
    send(walked)
    await expect.poll(() => backdrop(live.container)).toBeNull()
    await live.unmount()
  })
})

function sendRaw(source: EventTarget, type: string, data: object) {
  source.dispatchEvent(new MessageEvent(type, {data: JSON.stringify(data)}))
}

function sendAll(source: EventTarget, events: readonly {type: string; data: object}[]) {
  for (const event of events) sendRaw(source, event.type, event.data)
}

type Screen = Awaited<ReturnType<typeof render>>

const statusOf = (screen: Screen) => screen.container.querySelector('header p')

const details = (screen: Screen) => screen.getByRole('button', {name: 'Details'})

function barSays(screen: Screen, text: string) {
  return expect.poll(() => statusOf(screen)?.textContent).toContain(text)
}

function fillOf(screen: Screen) {
  const fill = screen.container.querySelector('header > span[aria-hidden] > span')
  return fill instanceof HTMLElement ? fill.style.transform : ''
}

function layoutOf(screen: Screen) {
  const header = screen.container.querySelector('header')
  const summary = header?.nextElementSibling
  if (!header || !summary) throw new Error('no header or summary')
  return {header: header.getBoundingClientRect().height, summary: summary.getBoundingClientRect().top}
}

async function approveInApp() {
  vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}'))
  const {source} = fakeEventSource()
  const screen = await render(<App loaded={{...fixture, openEvents: () => source}} />)
  await screen.getByRole('button', {name: 'Approve and delete'}).click()
  await barSays(screen, 'Approved · Claude is showing the commands in your terminal')
  return {screen, source}
}

describe('cleanup in the app', () => {
  beforeEach(() => {
    document.documentElement.style.setProperty('--fuse-window', '300ms')
    gsap.globalTimeline.timeScale(20)
  })
  afterEach(async () => {
    document.documentElement.style.removeProperty('--fuse-window')
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
    await emulateReducedMotion('no-preference')
  })

  test('approve hands back to Claude, then the bar, list and panel follow the real deletion', async () => {
    const {screen, source} = await approveInApp()
    sendRaw(source, 'done', {reclaimable: 7 * GB, elapsed_ms: 9500})
    sendRaw(source, 'waiting', {})
    for (const name of ['Approve and delete', 'Preview commands', 'Cancel', 'Rescan']) await expect.element(screen.getByRole('button', {name})).not.toBeInTheDocument()
    await expect.element(screen.getByText('Approved: the deletion runs in the background')).toBeVisible()
    await expect.element(screen.getByRole('checkbox', {name: 'Select all in Application caches'})).toBeDisabled()
    await expect.element(screen.getByText('Selected to free')).not.toBeInTheDocument()
    expect(screen.container.querySelectorAll('[data-film]')).toHaveLength(0)

    sendAll(source, cleanupEvents.slice(1, 3))
    await barSays(screen, 'Deleting · 2.0 GB of 3.8 GB · 1 of 5 · ~/Library/Caches/app-a')
    expect(fillOf(screen)).toMatch(/^scaleX\(0\.5333/)
    await expect.element(screen.getByText('1 of 4 removed')).toBeVisible()
    await expect.element(screen.getByRole('progressbar', {name: 'Application caches removed'})).toHaveAttribute('aria-valuenow', '53')
    await expect.element(screen.getByText('removed', {exact: true})).toBeVisible()
    await expect.element(screen.getByText('deleting', {exact: true}).first()).toBeVisible()
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toHaveClass('truncate font-mono text-[12.5px]')

    sendAll(source, cleanupEvents.slice(3))
    await barSays(screen, 'Freed 3.4 GB · 3 removed · 1 kept · 1 not removed')
    expect(fillOf(screen)).toBe('scaleX(1)')
    await expect.element(screen.getByText('3 of 4 removed')).toBeVisible()
    await expect.element(screen.getByRole('progressbar', {name: 'Application caches removed'})).toHaveAttribute('aria-valuenow', '93')
    await expect.element(screen.getByText('not removed: still present after removal: permission denied')).toBeVisible()
    await expect.element(screen.getByText('Freed', {exact: true})).toBeVisible()
    await expect.element(screen.getByRole('contentinfo')).toHaveTextContent('Cleanup finished4 items · 3.8 GB approved · a new cleanup starts with /disk-clean')
    expect(source.readyState).toBe(2)

    await details(screen).click()
    const panel = screen.getByRole('dialog', {name: 'Cleanup progress'})
    await expect.element(panel).toBeVisible()
    const rows = panel.getByRole('list', {name: 'Cleanup events'}).getByRole('listitem')
    await expect.element(rows.first()).toHaveTextContent('2.0sKept /Users/you/code/wt1 uncommitted or untracked files')
    await expect.element(rows.nth(1)).toHaveTextContent('1.6sNot removed ~/Library/Caches/app-dstill present after removal: permission denied')
    await expect.element(rows.nth(4)).toHaveTextContent('0.9sRemoved ~/Library/Caches/app-a2.0 GB in 1.0s')
    await panel.getByRole('button', {name: 'Problems'}).click()
    await expect.poll(() => rows.elements().length).toBe(2)
    await panel.getByRole('button', {name: 'Removed'}).click()
    await expect.poll(() => rows.elements().length).toBe(3)
    await panel.getByRole('button', {name: 'Commands'}).click()
    await expect.element(panel.getByText('Nothing here yet.')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(panel).not.toBeInTheDocument()
    await expect.element(details(screen)).toHaveFocus()
  })

  test('the movie opens on demand, keeps up with the stream and closes back to the app', async () => {
    const {screen, source} = await approveInApp()
    sendAll(source, cleanupEvents.slice(0, 3))
    await barSays(screen, 'Deleting ·')
    await details(screen).click()
    await screen.getByRole('button', {name: 'Watch the movie'}).click()
    const movie = screen.getByRole('dialog', {name: 'Cleanup movie'})
    await expect.element(movie.getByText('Application caches')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(movie).not.toBeInTheDocument()
    sendAll(source, cleanupEvents.slice(3, 6))
    await barSays(screen, 'Deleting · 3.5 GB of 3.8 GB · 3 of 5')
    await details(screen).click()
    await screen.getByRole('button', {name: 'Watch the movie'}).click()
    sendAll(source, cleanupEvents.slice(6))
    await expect.element(movie.getByRole('heading', {name: 'You freed'})).toBeVisible()
    const freed = screen.container.querySelector('[data-film="freed"]')
    if (!freed) throw new Error('no finale figure')
    await expect.element(page.elementLocator(freed)).toHaveTextContent(formatBytes(3.4 * GB))
    await expect.poll(() => screen.container.querySelector('[data-film="counter"]')?.textContent).toBe(formatBytes(3.4 * GB))
    await expect.element(movie.getByText('still present after removal: permission denied').first()).toBeInTheDocument()
    await expect.poll(() => screen.container.querySelector('[data-film]')?.closest('[data-settled]'), {timeout: 10_000}).not.toBeNull()
    expect(screen.container.querySelector('[data-film="particles"] canvas')).toBeNull()
    await movie.getByRole('button', {name: 'Close'}).click()
    await expect.element(movie).not.toBeInTheDocument()
    await expect.element(details(screen)).toHaveFocus()
    expect(document.querySelector('canvas')).toBeNull()
    await barSays(screen, 'Freed 3.4 GB')
  })

  test('a lost connection says so until the stream comes back, but not during the hand-back to the watcher', async () => {
    const {screen, source} = await approveInApp()
    source.readyState = 0
    source.dispatchEvent(new Event('error'))
    await barSays(screen, 'Approved · Claude is showing the commands in your terminal')
    source.readyState = 1
    sendAll(source, cleanupEvents.slice(0, 3))
    await barSays(screen, 'Deleting ·')
    source.readyState = 0
    source.dispatchEvent(new Event('error'))
    await barSays(screen, 'Reconnecting…')
    source.readyState = 1
    source.dispatchEvent(new Event('open'))
    await barSays(screen, 'Deleting ·')
  })

  test('a reload during the cleanup lands back in the app with the bar and panel', async () => {
    const {source} = fakeEventSource()
    const approved = ['/Users/you/Library/Caches/app-a', '/Users/you/code/web/node_modules']
    const screen = await render(<App loaded={{...fixture, approved, openEvents: () => source}} />)
    await expect.element(screen.getByRole('checkbox', {name: /node_modules/})).toBeChecked()
    await expect.element(screen.getByRole('checkbox', {name: /app-b/})).not.toBeChecked()
    sendAll(source, cleanupEvents.slice(0, 3))
    await barSays(screen, 'Deleting · 2.0 GB of 5.0 GB · 1 of 5')
    await details(screen).click()
    await expect.element(screen.getByRole('dialog', {name: 'Cleanup progress'}).getByText('Removed ~/Library/Caches/app-a')).toBeVisible()
  })

  test('reduced motion keeps the bar and panel and offers no movie', async () => {
    await emulateReducedMotion('reduce')
    const {screen, source} = await approveInApp()
    sendAll(source, cleanupEvents)
    await barSays(screen, 'Freed 3.4 GB · 3 removed · 1 kept · 1 not removed')
    await details(screen).click()
    await expect.element(screen.getByRole('dialog', {name: 'Cleanup progress'})).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Watch the movie'})).not.toBeInTheDocument()
    expect(document.querySelector('canvas')).toBeNull()
  })

  test('the header carries the progress without moving the layout, in the foreground colour', async () => {
    vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}'))
    const {source} = fakeEventSource()
    const screen = await render(<App loaded={{...fixture, openEvents: () => source}} />)
    await expect.element(screen.getByRole('button', {name: 'Approve and delete'})).toBeVisible()
    const before = layoutOf(screen)
    await screen.getByRole('button', {name: 'Approve and delete'}).click()
    await barSays(screen, 'Approved · Claude is showing the commands in your terminal')
    expect(layoutOf(screen)).toEqual(before)
    expect(fillOf(screen)).toBe('scaleX(1)')
    const status = statusOf(screen)
    if (!status) throw new Error('no status line')
    expect(getComputedStyle(status).color).toBe(getComputedStyle(document.body).color)
    sendAll(source, cleanupEvents.slice(0, 3))
    await barSays(screen, 'Deleting · 2.0 GB of 3.8 GB · 1 of 5')
    expect(layoutOf(screen)).toEqual(before)
    sendAll(source, cleanupEvents.slice(3))
    await barSays(screen, 'Freed 3.4 GB · 3 removed · 1 kept · 1 not removed')
    expect(layoutOf(screen)).toEqual(before)
    expect(getComputedStyle(status).color).toBe(getComputedStyle(document.body).color)
  })

  test('the cleanup log only grows, and outcomes already derived are reused, not rebuilt', () => {
    const plan = filmPlan(fixture.data.categories, fixture.data.categories[0]!.items, 3.75 * GB, 500 * GB)
    const events = cleanupEvents as readonly CleanupEvent[]
    const first = cleanupReducer(NO_CLEANUP, events.slice(0, 4))
    const next = cleanupReducer(first, events.slice(4))
    expect(next.log.slice(0, first.log.length).every((event, i) => event === first.log[i])).toBe(true)
    const before = outcomes(plan, first.log)
    const after = outcomes(plan, next.log)
    expect(after.slice(0, before.length).every((outcome, i) => outcome === before[i])).toBe(true)
    expect(outcomes(plan, next.log)).toBe(after)
    const removed = (path: string): CleanupEvent => ({type: 'removed', data: {path, bytes: 1, secs: 0, elapsed_ms: 1}})
    const left = cleanupReducer(first, [removed('/left')])
    const right = cleanupReducer(first, [removed('/right')])
    expect([left.keys.has('/left'), left.keys.has('/right'), right.keys.has('/right'), right.keys.has('/left'), first.keys.has('/left')]).toEqual([true, false, true, false, false])
    expect(cleanupReducer(right, [removed('/left')]).log.map(e => ('path' in e.data ? e.data.path : e.type)).slice(-2)).toEqual(['/right', '/left'])
    expect(cleanupReducer(left, [removed('/left')])).toBe(left)
    expect(after.map(o => o.key)).toEqual(outcomes(filmPlan(fixture.data.categories, fixture.data.categories[0]!.items, 3.75 * GB, 500 * GB), next.log).map(o => o.key))
  })

  test('a replayed stream adds no rows twice', () => {
    const plan = filmPlan(fixture.data.categories, fixture.data.categories[0]!.items, 3.75 * GB, 500 * GB)
    const events = cleanupEvents as readonly CleanupEvent[]
    const once = cleanupReducer(NO_CLEANUP, events)
    expect(cleanupReducer(once, events)).toBe(once)
    expect(cleanupReducer(NO_CLEANUP, [...events, ...events]).log).toEqual(once.log)
    expect(totalsOf(outcomes(plan, once.log), once.done)).toMatchObject({reclaimed: 3.4 * GB, sections: 1, seconds: 3})
  })
})

describe('cancel', () => {
  beforeEach(() => document.documentElement.style.setProperty('--fuse-window', '300ms'))
  afterEach(() => {
    document.documentElement.style.removeProperty('--fuse-window')
    vi.restoreAllMocks()
  })

  test('cancel has an undo window, and only a burnt-out fuse cancels', async () => {
    vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}'))
    const screen = await render(<App loaded={fixture} />)
    const cancel = screen.getByRole('button', {name: 'Cancel'})
    await cancel.click()
    await screen.getByRole('button', {name: 'Undo'}).click()
    await expect.element(cancel).toHaveStyle(SHOWN)
    expect(window.fetch).not.toHaveBeenCalled()
    await cancel.click()
    await expect.element(screen.getByRole('heading', {name: 'Cancelled'})).toBeVisible()
    expect(window.fetch).toHaveBeenCalledWith('/decide', expect.objectContaining({body: expect.stringContaining('"decision":"cancel"')}))
  })
})

function Swapping({text}: {text: string}) {
  const label = useTextSwap(text)
  return (
    <span ref={label.ref} className="t-text-swap">
      {label.shown}
    </span>
  )
}

describe('text swap', () => {
  test('text that flips back before the swap finishes stays visible', async () => {
    const screen = await render(<Swapping text="Preview commands" />)
    await screen.rerender(<Swapping text="Checking…" />)
    await screen.rerender(<Swapping text="Preview commands" />)
    await settle(cssMs('--text-swap-dur', 150) * 2)
    await expect.element(screen.getByText('Preview commands')).toHaveStyle({opacity: '1'})
  })
})

function press(key: string) {
  document.body.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true}))
}

const NESTED: Loaded = {
  ...fixture,
  data: {
    ...fixture.data,
    categories: [
      category('worktrees', 'Git worktrees', 'safe', [item('/Users/you/code/wt', 4 * GB)]),
      category('node', 'node_modules', 'safe', [item('/Users/you/code/wt/node_modules', GB), item('/Users/you/code/app/node_modules', GB)]),
    ],
  },
}

const NAMES: Loaded = {
  ...fixture,
  data: {...fixture.data, categories: [category('caches', 'Caches', 'safe', ['cache-10', 'cache-2', 'cache-1', 'Cache-3'].map(name => item(`/Users/you/${name}`, GB)))]},
}

describe('list fixes from QA', () => {
  beforeEach(() => document.documentElement.style.setProperty('--fuse-window', '300ms'))
  afterEach(async () => {
    document.documentElement.style.removeProperty('--fuse-window')
    vi.restoreAllMocks()
    await page.viewport(1440, 960)
  })

  test('REV-3: closing the preview dialog returns focus to Preview commands', async () => {
    vi.spyOn(window, 'fetch').mockResolvedValue(new Response(JSON.stringify({commands: ['rm -rf -- /x'], rejected: [], count: 1, bytes: GB})))
    const screen = await render(<App loaded={fixture} />)
    const preview = screen.getByRole('button', {name: 'Preview commands'})
    await preview.click()
    await expect.element(screen.getByRole('dialog')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
    await expect.element(preview).toHaveFocus()
  })

  test('REV-4: at 1024 px the footer buttons keep their full label and icon', async () => {
    await page.viewport(1024, 768)
    const screen = await render(<App loaded={fixture} />)
    for (const name of ['Cancel', 'Preview commands', 'Approve and delete']) {
      const button = screen.getByRole('button', {name}).element()
      expect(button.scrollWidth, name).toBeLessThanOrEqual(button.clientWidth + 1)
      expect(button.querySelector('svg')?.getBoundingClientRect().width, name).toBeGreaterThanOrEqual(14)
    }
  })

  test('REV-5: deselecting everything while Approve is armed never approves', async () => {
    vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}'))
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('button', {name: 'Approve and delete'}).click()
    await expect.element(screen.getByRole('button', {name: 'Undo'})).toHaveStyle(SHOWN)
    press('d')
    await expect.element(screen.getByText('0 items selected · 0 B')).toBeVisible()
    await settle(cssMs('--fuse-window', 300) * 2)
    expect(window.fetch).not.toHaveBeenCalled()
    await expect.element(screen.getByRole('button', {name: 'Approve and delete'})).toBeDisabled()
  })

  test('REV-6: section sizes and counts follow the active filters', async () => {
    const screen = await render(<App loaded={fixture} />)
    const caches = screen.getByRole('button', {name: /^Application caches/})
    await expect.element(caches).toHaveTextContent('Application caches3.8 GB4/4')
    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('app-a')
    await expect.element(caches).toHaveTextContent('Application caches2.0 GB1/1')
    await expect.element(screen.getByRole('button', {name: /^node_modules/})).not.toBeInTheDocument()
  })

  test('REV-7: name sort is natural and ignores case', async () => {
    const screen = await render(<App loaded={NAMES} />)
    await screen.getByRole('combobox', {name: 'Sort'}).click()
    await screen.getByRole('option', {name: 'Name'}).click()
    const names = () => [...screen.container.querySelectorAll('[role="row"] [data-label]')].map(el => el.textContent)
    await expect.poll(names).toEqual(['~/cache-1', '~/cache-2', '~/Cache-3', '~/cache-10'])
  })

  test('STO-4 / REV-12: a selected path inside another selected path counts once', async () => {
    const screen = await render(<App loaded={NESTED} />)
    await expect.element(screen.getByText('3 items selected · 5.0 GB')).toBeVisible()
    await screen.getByRole('button', {name: /^node_modules/}).click()
    await screen.getByRole('checkbox', {name: '~/code/app/node_modules'}).click()
    await expect.element(screen.getByText('2 items selected · 4.0 GB')).toBeVisible()
    expect(outermost(NESTED.data.categories.flatMap(c => c.items)).map(i => i.path)).toEqual(['/Users/you/code/wt', '/Users/you/code/app/node_modules'])
  })

  test('the list is a table with its full row count for assistive tech', async () => {
    const screen = await render(<App loaded={fixture} />)
    const table = screen.getByRole('table', {name: 'Application caches'})
    await expect.element(table).toHaveAttribute('aria-rowcount', '5')
    await expect.element(table.getByRole('row').nth(1)).toHaveAttribute('aria-rowindex', '2')
  })
})

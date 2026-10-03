import {hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode} from 'd3-hierarchy'
import {useState} from 'react'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {cdp, page, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {ActionBar} from './components/action-bar'
import {PreviewDialog} from './components/preview-dialog'
import {formatBytes, NO_DATA, type Category, type Loaded} from './lib/data'
import {cssMs} from './lib/motion'
import {scanReducer, startScan, type ScanEvent} from './lib/scan'
import {NO_PICKS, picksReducer, useSelection} from './lib/selection'
import {squarifyInBounds} from './lib/treemap-tile'
import {fixture} from './test/fixture'
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

  test('hovering the sunburst names the folder and its size', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('tab', {name: 'Storage'}).click()
    const chart = screen.getByLabelText(/Storage sunburst/)
    await expect.element(chart).toBeVisible()
    const sector = chart.element().querySelector('path')
    if (!sector) throw new Error('the sunburst drew no sectors')
    await userEvent.hover(page.elementLocator(sector))
    const tip = page.getByText(/^(Library|code) · \d+(\.\d)? GB · \d+\.\d% of ~$/)
    await expect.element(tip).toBeVisible()
    await expect.element(page.getByText(/^x /)).not.toBeInTheDocument()
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

  test('a finished run starts walked and done', () => {
    expect(startScan(fixture)).toMatchObject({walked: true, done: true, data: fixture.data})
  })

  test('preselected items are selected when they arrive, and an unticked one stays unticked on replay', () => {
    const appA = items[0]?.type === 'item' ? items[0].data.item : undefined
    if (!appA) throw new Error('fixture has no first item')
    const first = picksReducer(NO_PICKS, {type: 'offer', items: itemsOf(items.slice(0, 2))})
    expect([...first.on]).toEqual(['/Users/you/Library/Caches/app-a', '/Users/you/Library/Caches/app-b'])
    const unticked = picksReducer(first, {type: 'set', items: [appA], value: false})
    const replayed = picksReducer(unticked, {type: 'offer', items: itemsOf([...items, ...items])})
    expect(replayed.on.has(appA.path)).toBe(false)
    expect(replayed.on.has('/Users/you/Library/Caches/app-d')).toBe(true)
    expect(replayed.on.has('/Users/you/code/web/node_modules')).toBe(false)
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
    await expect.element(screen.getByText(/queued for deletion/)).not.toBeInTheDocument()
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

async function approveFixture() {
  vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}'))
  const screen = await render(<App loaded={fixture} />)
  await screen.getByRole('button', {name: 'Approve and delete'}).click()
  return screen
}

function emulateReducedMotion(value: 'reduce' | 'no-preference') {
  return cdp().send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value}]})
}

function frameOf(canvas: Element | null | undefined) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no canvas')
  return canvas.toDataURL()
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

  test('the approved screen gathers the approved size into a labelled particle canvas', async () => {
    const screen = await approveFixture()
    const size = screen.getByRole('img', {name: '3.8 GB'})
    await expect.element(size).toBeVisible()
    expect(size.element().querySelector('canvas')).toBeInstanceOf(HTMLCanvasElement)
    await expect.element(screen.getByRole('heading', {name: 'queued for deletion'})).toBeInTheDocument()
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

    const screen = await approveFixture()
    const size = screen.getByRole('img', {name: '3.8 GB'})
    await expect.element(size).toBeVisible()
    const particles = () => size.element().querySelector('canvas')
    await settle(500)
    const textFrame = frameOf(particles())
    await settle(300)
    expect(frameOf(particles())).toBe(textFrame)
  })
})

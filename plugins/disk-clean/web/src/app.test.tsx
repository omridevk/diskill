import {hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode} from 'd3-hierarchy'
import {describe, expect, test} from 'vitest'
import {page, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {PreviewDialog} from './components/preview-dialog'
import {formatBytes} from './lib/data'
import {cssMs} from './lib/motion'
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

  test('review items need a second click before approving', async () => {
    const screen = await render(<App loaded={fixture} />)
    await screen.getByRole('button', {name: /^Docker/}).click()
    await screen.getByText('docker system prune -f').click()
    await expect.element(screen.getByText(/marked review selected/)).toBeVisible()
    await screen.getByRole('button', {name: 'Approve and delete'}).click()
    await expect.element(screen.getByRole('button', {name: 'Click again to confirm'})).toBeVisible()
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

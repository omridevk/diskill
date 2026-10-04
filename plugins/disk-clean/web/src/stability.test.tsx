import {afterEach, describe, expect, test, vi} from 'vitest'
import {page} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {NO_DATA, type Item, type Loaded} from './lib/data'
import type {CategoryHead, ScanEvent} from './lib/scan-feed'
import {at, item} from './test/fixture'
import {fakeEventSource} from './test/page'
import './index.css'

type Screen = Awaited<ReturnType<typeof render>>
type Box = {x: number; y: number; width: number; height: number}

const GB = 1024 ** 3
const LIVE: Loaded = {data: NO_DATA, token: 'test-token', home: '/Users/you', live: true}
const CACHES: CategoryHead = {id: 'caches', title: 'Application caches', desc: 'Caches apps rebuild on demand.', risk: 'safe'}
const WORKTREES: CategoryHead = {id: 'worktrees', title: 'Git worktrees with no leftover work', desc: 'worktrees', risk: 'safe'}
const DOCKER: CategoryHead = {id: 'docker', title: 'Docker', desc: 'docker', risk: 'review'}
const caches = ['app-a', 'app-b', 'app-c', 'app-d', 'app-e'].map((name, i) => item(`/Users/you/Library/Caches/${name}`, (5 - i) * GB, {line: 1, age: i * 100}))
const worktree = item('/Users/you/code/wt', 0, {action: 'worktree', label: '~/code/wt', preselect: false, checking: true})
const docker = item('cmd:docker-prune', 13.7 * GB, {action: 'cmd', cmd_id: 'docker-prune', label: 'docker system prune -f', accuracy: 'vm', preselect: false, age: null})

function listed(category: CategoryHead, entry: Item, elapsed_ms: number): ScanEvent {
  return {type: 'item', data: {category, item: entry, elapsed_ms}}
}

async function settled() {
  await new Promise(requestAnimationFrame)
  const finite = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
  await Promise.all(finite.map(animation => animation.finished.catch(() => undefined)))
  await new Promise(requestAnimationFrame)
}

const SHOTS = import.meta.env.VITE_EMPTY_SHOTS === '1'

async function stripShot(screen: Screen, name: string) {
  const strip = summaryOf(screen)
  if (!SHOTS || !(strip instanceof HTMLElement)) return
  await page.screenshot({path: `../node_modules/.empty-shots/${name}-${navigator.userAgent.includes('Firefox') ? 'firefox' : 'chromium'}.png`, element: strip})
}

function summaryOf(screen: Screen) {
  return screen.getByText('free after').element().closest('section')
}

const LANDMARKS: Record<string, (screen: Screen) => Element | null | undefined> = {
  header: () => document.querySelector('header'),
  tabs: screen => screen.getByRole('tablist').element(),
  'summary strip': summaryOf,
  donut: screen => [...(summaryOf(screen)?.children ?? [])].find(child => child.textContent?.includes('free after')),
  'hero number': screen => screen.getByText(/^(Selected to free|Held, not freed yet|Freed)$/).element().nextElementSibling,
  legend: screen => screen.getByText('Used', {exact: true}).element().parentElement,
  toolbar: screen => screen.getByRole('textbox', {name: 'Filter paths'}).element().closest('.border-b'),
  'list top edge': () => document.querySelector('main'),
  'open section header': () => document.querySelector('main')?.firstElementChild,
  'action bar': () => document.querySelector('footer'),
  'Delete button': () => document.querySelector('footer > button:last-child'),
}

const TOP_ONLY = new Set(['list top edge'])

function measure(screen: Screen) {
  const boxes = new Map<string, Box>()
  for (const [name, find] of Object.entries(LANDMARKS)) {
    const element = find(screen)
    if (!element) continue
    const {x, y, width, height} = element.getBoundingClientRect()
    boxes.set(name, TOP_ONLY.has(name) ? {x: 0, y, width: 0, height: 0} : {x, y, width, height})
  }
  return boxes
}

function moved(first: Box, now: Box) {
  return Math.max(Math.abs(first.x - now.x), Math.abs(first.y - now.y), Math.abs(first.width - now.width), Math.abs(first.height - now.height))
}

type Source = {node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly}

function displaced({node, previousRect, currentRect}: Source) {
  if (!(node instanceof Element) || node.closest('nav[aria-label="Sections"], .tabular-nums')) return false
  return Math.abs(previousRect.width - currentRect.width) < 1 && Math.abs(previousRect.height - currentRect.height) < 1
}

function watchShifts() {
  const shifts: string[] = []
  if (!PerformanceObserver.supportedEntryTypes.includes('layout-shift')) return {shifts, stop: () => undefined}
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const shift = entry as PerformanceEntry & {value: number; hadRecentInput: boolean; sources?: Source[]}
      if (shift.hadRecentInput || shift.value < 0.0001) continue
      const nodes = (shift.sources ?? []).filter(displaced).map(source => `${(source.node?.textContent ?? '').slice(0, 40)} [${source.node instanceof Element ? source.node.tagName : source.node?.nodeName}] ${Math.round(source.previousRect.x)},${Math.round(source.previousRect.y)} ${Math.round(source.previousRect.width)}x${Math.round(source.previousRect.height)} -> ${Math.round(source.currentRect.x)},${Math.round(source.currentRect.y)} ${Math.round(source.currentRect.width)}x${Math.round(source.currentRect.height)}`)
      if (nodes.length > 0) shifts.push(`${shift.value.toFixed(4)} ${nodes.join(' | ')}`)
    }
  })
  observer.observe({type: 'layout-shift'})
  return {shifts, stop: () => observer.disconnect()}
}

describe('nothing moves unless the user moved it', () => {
  afterEach(() => vi.restoreAllMocks())

  test('a streaming session with selection, filters and the apparent note keeps every landmark in place', async () => {
    const {source, send} = fakeEventSource()
    const screen = await render(<App loaded={{...LIVE, openEvents: () => source}} history={at('/cleanup/caches')} />)
    await document.fonts.ready
    const layout = watchShifts()
    const first = new Map<string, Box>()
    const caught: string[] = []
    const check = async (step: string) => {
      await settled()
      for (const [name, box] of measure(screen)) {
        const was = first.get(name)
        if (!was) first.set(name, box)
        else if (moved(was, box) > 1) caught.push(`${name} moved ${moved(was, box).toFixed(1)} px at "${step}" ${JSON.stringify(was)} -> ${JSON.stringify(box)}`)
      }
      for (const shift of layout.shifts.splice(0)) caught.push(`layout-shift at "${step}": ${shift}`)
    }

    send({type: 'disk', data: {total: 500 * GB, used: 400 * GB, free: 50 * GB, snapshots: 0, elapsed_ms: 10}})
    send({type: 'progress', data: {files: 1234, bytes: 5 * GB, dir: '/Users/you/Library/Caches', elapsed_ms: 50}})
    send(listed(CACHES, caches[0]!, 60))
    await expect.element(screen.getByRole('heading', {name: CACHES.title})).toBeVisible()
    await check('first item')

    send({type: 'progress', data: {files: 1_234_567, bytes: 250 * GB, dir: '/Users/you/Library/Application Support/Some/Deep/Folder', elapsed_ms: 400}})
    for (const [i, entry] of caches.slice(1).entries()) send(listed(CACHES, entry, 100 + i))
    await expect.element(screen.getByText('~/Library/Caches/app-e')).toBeVisible()
    await check('items stream in')

    send(listed(WORKTREES, worktree, 200))
    send(listed(DOCKER, {...docker, checking: true}, 210))
    await expect.element(screen.getByRole('checkbox', {name: `Select all in ${CACHES.title}`})).toBeVisible()
    await check('worktree and docker arrive checking')

    send({type: 'walked', data: {home: 40 * GB, tree: null, insights: null, worktrees: 1, elapsed_ms: 500}})
    send(listed(WORKTREES, {...worktree, checking: false, bytes: GB}, 520))
    send(listed(DOCKER, docker, 530))
    await expect.element(screen.getByRole('checkbox', {name: 'Select all in Docker'})).toBeVisible()
    await check('worktree checks resolve')
    await stripShot(screen, `strip-${import.meta.env.VITE_SHOT_TAG ?? 'after'}-without-note`)

    await screen.getByRole('checkbox', {name: 'Select all in Docker'}).click()
    await expect.element(screen.getByRole('contentinfo').getByRole('button', {name: /1 review item/})).toBeVisible()
    await expect.element(screen.getByText(/apparent \(Docker VM, clones\), not counted/)).toBeInTheDocument()
    await check('a review item is selected and the apparent note appears')
    await stripShot(screen, `strip-${import.meta.env.VITE_SHOT_TAG ?? 'after'}-with-note`)

    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('app-a')
    await expect.element(screen.getByRole('contentinfo').getByRole('button', {name: /hidden/})).toBeVisible()
    await check('a selected item is hidden by a filter')

    await screen.getByRole('textbox', {name: 'Filter paths'}).fill('')
    await screen.getByRole('button', {name: 'review', exact: true}).click()
    await check('risk filter on')
    await screen.getByRole('button', {name: 'review', exact: true}).click()
    await check('risk filter off')

    await screen.getByRole('button', {name: 'Clear selection'}).click()
    await expect.element(screen.getByText('0 items selected · 0 B')).toBeVisible()
    await check('selection cleared')
    await screen.getByRole('button', {name: 'Reset to recommended'}).click()
    await expect.element(screen.getByText(/^5 items selected/)).toBeVisible()
    await check('selection reset')

    send({type: 'done', data: {reclaimable: 30 * GB, elapsed_ms: 900}})
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await check('scan finishes')

    layout.stop()
    expect(caught).toEqual([])
  }, 30_000)
})

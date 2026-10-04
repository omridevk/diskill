import type {RouterHistory} from '@tanstack/react-router'
import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {formatBytes} from './lib/data'
import {at, fixture, freeEvents, heldEvents, undoEvents} from './test/fixture'
import type {Loaded} from './lib/data'
import {fakeEventSource, mockServer, PLAN, sendAll, sendRaw} from './test/page'
import './index.css'

const GB = 1024 ** 3
const DELETE = /^Delete \d+ items? · /

type Screen = Awaited<ReturnType<typeof render>>

const statusOf = (screen: Screen) => screen.container.querySelector('header p')
const barSays = (screen: Screen, text: string) => expect.poll(() => statusOf(screen)?.textContent).toContain(text)
const posted = (url: string) => vi.mocked(window.fetch).mock.calls.filter(([to]) => String(to) === url)
const footer = (screen: Screen) => screen.getByRole('contentinfo')

const LONG_NAME = 'ms-vscode.cpptools-a-very-long-item-name-that-must-stay-visible'
const LONG = `/Users/you/Library/Application Support/Code/User/workspaceStorage/0f3a9c2b7d1e4a6f8b5c3d2e1f0a9b8c/${LONG_NAME}`

async function openApp(url = '/cleanup', plan: object = PLAN, failing: ReadonlySet<string> = new Set()) {
  mockServer(plan, failing)
  const {source} = fakeEventSource()
  const history: RouterHistory = at(url)
  const screen = await render(<App loaded={{...fixture, openEvents: () => source}} history={history} />)
  return {screen, source, history}
}

async function heldApp() {
  const opened = await openApp()
  await opened.screen.getByRole('button', {name: DELETE}).click()
  await opened.screen.getByRole('dialog').getByRole('button', {name: /^Move 4 items to hold/}).click()
  await barSays(opened.screen, 'Approved · Claude is showing the commands in your terminal')
  await sendAll(opened.source, heldEvents)
  await barSays(opened.screen, `Held ${formatBytes(3.75 * GB)} · not freed yet · undo until`)
  return opened
}

describe('Delete asks in a modal', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('Delete opens the grouped confirm modal; Cancel and Escape change nothing; Confirm approves without a fuse', async () => {
    const {screen, history} = await openApp()
    const remove = screen.getByRole('button', {name: DELETE})
    await expect.element(remove).toHaveTextContent('Delete 4 items · 3.8 GB')
    await expect.element(screen.getByRole('button', {name: /Preview/})).not.toBeInTheDocument()

    await remove.click()
    const dialog = screen.getByRole('dialog', {name: 'Confirm the cleanup'})
    expect(history.location.pathname).toBe('/cleanup/caches/confirm')
    await expect.element(dialog.getByRole('heading', {name: /^Moved to hold \(undo available\)/})).toBeVisible()
    await expect.element(dialog.getByRole('heading', {name: /^Can't be undone/})).toBeVisible()
    await expect.element(dialog.getByRole('heading', {name: /^Rejected by the safety checks/})).toBeVisible()
    await expect.poll(() => dialog.getByRole('list', {name: 'Moved to hold'}).getByRole('listitem').elements().length).toBe(4)
    await dialog.getByRole('button', {name: 'Cancel'}).click()
    await expect.element(dialog).not.toBeInTheDocument()
    expect(history.location.pathname).toBe('/cleanup/caches')
    await expect.element(remove).toHaveFocus()

    await remove.click()
    await expect.element(dialog).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    expect(posted('/decide')).toHaveLength(0)
    await expect.element(remove).toBeEnabled()

    await remove.click()
    await dialog.getByRole('button', {name: "Move 4 items to hold + 2 that can't be undone"}).click()
    await barSays(screen, 'Approved · Claude is showing the commands in your terminal')
    const [[, init]] = posted('/decide') as [[string, RequestInit]]
    expect(JSON.parse(String(init.body))).toMatchObject({decision: 'approve', token: 'test-token'})
    expect(JSON.parse(String(init.body)).items).toHaveLength(4)
    await expect.element(screen.getByRole('button', {name: 'Undo'})).not.toBeInTheDocument()
    await expect.element(screen.getByRole('button', {name: DELETE})).not.toBeInTheDocument()
  })

  test('paths read from the home folder, and a long path keeps its name', async () => {
    const plan = {...PLAN, hold: [{path: LONG, bytes: GB, held: '/Users/you/.cache/disk-clean/held/run-1/9'}, ...PLAN.hold]}
    const {screen} = await openApp('/cleanup', plan)
    await screen.getByRole('button', {name: DELETE}).click()
    const dialog = screen.getByRole('dialog', {name: 'Confirm the cleanup'})
    const held = dialog.getByRole('list', {name: 'Moved to hold'}).getByRole('listitem')
    await expect.element(held.first()).toHaveTextContent(`~/Library/Application Support/Code/User/workspaceStorage/0f3a9c2b7d1e4a6f8b5c3d2e1f0a9b8c/${LONG_NAME}1.0 GB`)
    await expect.element(held.nth(1)).toHaveTextContent('~/Library/Caches/app-a2.0 GB')
    await expect.element(dialog.getByRole('list', {name: "Can't be undone"}).getByRole('listitem').first()).toHaveTextContent('git -C ~/code worktree remove ~/code/wt')
    await expect.element(dialog.getByRole('list', {name: 'Rejected by the safety checks'})).toHaveTextContent('~/old: already gone')
    await expect.element(dialog.getByText('/Users/you', {exact: false})).not.toBeInTheDocument()
  })
})

describe('held, then undone or freed', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('holding is never shown as freed, and Undo puts everything back', async () => {
    const {screen, source} = await heldApp()
    await expect.element(screen.getByText('Held, not freed yet')).toBeVisible()
    await expect.element(screen.getByText('held · not freed yet').first()).toBeVisible()
    await expect.poll(() => footer(screen).element().textContent).toMatch(/^Held 3\.8 GB · not freed yet.*undo available until .*, then freed by the next disk-clean run/)
    expect(statusOf(screen)?.textContent).toContain(`freed ${formatBytes(GB)}`)
    expect(source.readyState).toBe(1)

    await footer(screen).getByRole('button', {name: 'Undo'}).click()
    await expect.poll(() => posted('/undo').length).toBe(1)
    expect(JSON.parse(String((posted('/undo')[0]?.[1] as RequestInit).body))).toEqual({token: 'test-token'})
    await sendAll(source, undoEvents.slice(0, 2))
    await barSays(screen, 'Undoing ·')
    await sendAll(source, undoEvents.slice(2))
    await barSays(screen, `Restored ${formatBytes(3.75 * GB)} · nothing is held`)
    await expect.element(screen.getByText('restored', {exact: true}).first()).toBeVisible()
    await expect.element(screen.getByText('4 restored', {exact: true})).toBeVisible()
    await expect.element(screen.getByText(/ of \d+ done/)).not.toBeInTheDocument()
    await expect.element(screen.getByText(`Restored · nothing is held · freed ${formatBytes(GB)}`)).toBeVisible()
    await expect.poll(() => footer(screen).element().textContent).toMatch(new RegExp(`^Restored ${formatBytes(3.75 * GB)} · nothing is held`))
    await screen.getByRole('button', {name: 'Details'}).click()
    const details = screen.getByRole('dialog', {name: 'Cleanup progress'})
    await expect.element(details.getByText('Restored', {exact: true})).toBeVisible()
    await expect.element(details.getByText(`Nothing is held · freed ${formatBytes(GB)}`)).toBeVisible()
    await expect.element(footer(screen).getByRole('button', {name: 'Free the space now'})).not.toBeInTheDocument()
    expect(source.readyState).toBe(2)
  })

  test('Free the space now asks first, then the freed figure and the movie payoff follow the real free', async () => {
    const {screen, source, history} = await heldApp()
    await screen.getByRole('button', {name: 'Details'}).click()
    await screen.getByRole('button', {name: 'Watch the movie'}).click()
    const movie = screen.getByRole('dialog', {name: 'Cleanup movie'})
    await expect.element(movie.getByRole('heading', {name: 'Moved to hold'})).toBeVisible()
    await expect.element(movie.getByRole('heading', {name: 'You freed'})).not.toBeInTheDocument()
    await movie.getByRole('button', {name: 'Free the space now'}).click()
    const over = screen.getByRole('dialog', {name: 'Free the space now?'})
    await expect.element(over).toBeVisible()
    expect(history.location.pathname).toBe('/cleanup/caches/free')
    await userEvent.keyboard('{Escape}')
    await expect.element(over).not.toBeInTheDocument()
    await expect.element(movie).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await expect.element(movie).not.toBeInTheDocument()

    const free = footer(screen).getByRole('button', {name: 'Free the space now'})
    await free.click()
    const confirm = screen.getByRole('dialog', {name: 'Free the space now?'})
    await expect.element(confirm).toBeVisible()
    expect(history.location.pathname).toBe('/cleanup/caches/free')
    await userEvent.keyboard('{Escape}')
    await expect.element(confirm).not.toBeInTheDocument()
    await expect.poll(() => history.location.pathname).toBe('/cleanup/caches')
    expect(posted('/free')).toHaveLength(0)

    await free.click()
    await confirm.getByRole('button', {name: `Free ${formatBytes(3.75 * GB)} for good`}).click()
    await expect.poll(() => posted('/free').length).toBe(1)
    await expect.poll(() => history.location.pathname).toBe('/cleanup/caches')
    await sendAll(source, freeEvents.slice(0, 3))
    await barSays(screen, 'Freeing ·')
    await sendAll(source, freeEvents.slice(3))
    await barSays(screen, `Freed ${formatBytes(4.75 * GB)} · 5 removed`)
    await expect.element(screen.getByText('Freed', {exact: true})).toBeVisible()
    await expect.element(screen.getByText('freed', {exact: true}).first()).toBeVisible()

    await screen.getByRole('button', {name: 'Details'}).click()
    await screen.getByRole('button', {name: 'Watch the movie'}).click()
    await expect.element(movie.getByRole('heading', {name: 'You freed'})).toBeVisible()
    await expect.poll(() => document.querySelector('[data-film="freed"]')?.textContent).toBe(formatBytes(4.75 * GB))
  })

  test('the Free confirm is its own address and is refused when nothing is held', async () => {
    const cold = await openApp('/cleanup/caches/free')
    await expect.poll(() => cold.history.location.pathname).toBe('/cleanup/caches')
    await expect.element(cold.screen.getByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('a request the server refuses rolls back and says so where it was made', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('a refused Delete rolls back to the list, shows why at the footer, and Retry approves once the server recovers', async () => {
    const failing = new Set(['/decide'])
    const {screen} = await openApp('/cleanup', PLAN, failing)
    await screen.getByRole('button', {name: DELETE}).click()
    await screen.getByRole('dialog').getByRole('button', {name: /^Move 4 items to hold/}).click()
    await expect.element(footer(screen).getByText('Delete did not go through, nothing was deleted: disk-clean answered 500 to /decide: server said no')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: DELETE})).toBeEnabled()
    expect(statusOf(screen)?.textContent).toContain('nothing is deleted until you approve')
    failing.delete('/decide')
    await footer(screen).getByRole('button', {name: 'Retry'}).click()
    await barSays(screen, 'Approved · Claude is showing the commands in your terminal')
    await expect.element(screen.getByText(/did not go through/)).not.toBeInTheDocument()
  })

  test('a refused Undo or Free keeps everything held and offers Retry at the held actions', async () => {
    const opened = await heldApp()
    const failing = new Set(['/undo', '/free'])
    vi.restoreAllMocks()
    mockServer(PLAN, failing)
    await footer(opened.screen).getByRole('button', {name: 'Undo'}).click()
    await expect.element(footer(opened.screen).getByText('Undo did not start: disk-clean answered 500 to /undo: server said no')).toBeVisible()
    await expect.element(footer(opened.screen).getByRole('button', {name: 'Undo'})).toBeEnabled()
    await footer(opened.screen).getByRole('button', {name: 'Free the space now'}).click()
    await opened.screen.getByRole('dialog', {name: 'Free the space now?'}).getByRole('button', {name: `Free ${formatBytes(3.75 * GB)} for good`}).click()
    await expect.element(footer(opened.screen).getByText('Free did not start: disk-clean answered 500 to /free: server said no')).toBeVisible()
    await barSays(opened.screen, `Held ${formatBytes(3.75 * GB)} · not freed yet`)
    failing.clear()
    await footer(opened.screen).getByRole('button', {name: 'Retry'}).first().click()
    await expect.poll(() => posted('/undo').length).toBe(2)
    await expect.element(footer(opened.screen).getByText(/Undo did not start/)).not.toBeInTheDocument()
  })

  test('a refused Rescan rolls back to the finished scan and offers Retry beside the button', async () => {
    const failing = new Set(['/rescan'])
    mockServer(PLAN, failing)
    const {source} = fakeEventSource()
    const loaded: Loaded = {...fixture, live: true, openEvents: () => source}
    const screen = await render(<App loaded={loaded} history={at('/cleanup')} />)
    sendRaw(source, 'done', {reclaimable: 0, elapsed_ms: 10})
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await screen.getByRole('button', {name: 'Rescan'}).click()
    await expect.element(screen.getByText('Rescan did not start: disk-clean answered 500 to /rescan: server said no')).toBeVisible()
    await expect.element(screen.getByText('Scan complete')).toBeVisible()
    await expect.element(screen.getByRole('button', {name: 'Rescan'})).toBeEnabled()
  })

  test('a dropped scan stream says it is reconnecting until the stream comes back', async () => {
    const {source} = fakeEventSource()
    const screen = await render(<App loaded={{...fixture, live: true, openEvents: () => source}} history={at('/cleanup')} />)
    sendRaw(source, 'disk', {total: 500 * GB, used: 400 * GB, free: 50 * GB, snapshots: 0, elapsed_ms: 1})
    await expect.element(screen.getByText('Walking disk')).toBeVisible()
    source.readyState = 0
    source.dispatchEvent(new Event('error'))
    await expect.element(screen.getByText('Reconnecting to disk-clean…')).toBeVisible()
    source.readyState = 1
    source.dispatchEvent(new Event('open'))
    await expect.element(screen.getByText('Reconnecting to disk-clean…')).not.toBeInTheDocument()
  })

  test('a cleanup stream that closes for good says contact is lost, not that the cleanup stopped', async () => {
    const {screen, source} = await heldApp()
    sendAll(source, undoEvents.slice(0, 1))
    await barSays(screen, 'Undoing ·')
    source.readyState = 2
    source.dispatchEvent(new Event('error'))
    await barSays(screen, 'Lost contact with disk-clean: the cleanup keeps running; reload to reconnect')
  })
})

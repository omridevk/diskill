import type {RouterHistory} from '@tanstack/react-router'
import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {formatBytes} from './lib/data'
import {at, fixture, freeEvents, heldEvents, undoEvents} from './test/fixture'
import {fakeEventSource, mockServer, sendAll} from './test/page'
import './index.css'

const GB = 1024 ** 3
const DELETE = /^Delete \d+ items? · /

type Screen = Awaited<ReturnType<typeof render>>

const statusOf = (screen: Screen) => screen.container.querySelector('header p')
const barSays = (screen: Screen, text: string) => expect.poll(() => statusOf(screen)?.textContent).toContain(text)
const posted = (url: string) => vi.mocked(window.fetch).mock.calls.filter(([to]) => String(to) === url)
const footer = (screen: Screen) => screen.getByRole('contentinfo')

async function openApp(url = '/cleanup') {
  mockServer()
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
  sendAll(opened.source, heldEvents)
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
    expect(history.location.pathname).toBe('/cleanup/confirm')
    await expect.element(dialog.getByRole('heading', {name: /^Moved to hold \(undo available\)/})).toBeVisible()
    await expect.element(dialog.getByRole('heading', {name: /^Can't be undone/})).toBeVisible()
    await expect.element(dialog.getByRole('heading', {name: /^Rejected by the safety checks/})).toBeVisible()
    await expect.poll(() => dialog.getByRole('list', {name: 'Moved to hold'}).getByRole('listitem').elements().length).toBe(4)
    await dialog.getByRole('button', {name: 'Cancel'}).click()
    await expect.element(dialog).not.toBeInTheDocument()
    expect(history.location.pathname).toBe('/cleanup')
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
    sendAll(source, undoEvents.slice(0, 2))
    await barSays(screen, 'Undoing ·')
    sendAll(source, undoEvents.slice(2))
    await barSays(screen, `Restored ${formatBytes(3.75 * GB)} · nothing is held`)
    await expect.element(screen.getByText('restored', {exact: true}).first()).toBeVisible()
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
    expect(history.location.pathname).toBe('/cleanup/free')
    await userEvent.keyboard('{Escape}')
    await expect.element(over).not.toBeInTheDocument()
    await expect.element(movie).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await expect.element(movie).not.toBeInTheDocument()

    const free = footer(screen).getByRole('button', {name: 'Free the space now'})
    await free.click()
    const confirm = screen.getByRole('dialog', {name: 'Free the space now?'})
    await expect.element(confirm).toBeVisible()
    expect(history.location.pathname).toBe('/cleanup/free')
    await userEvent.keyboard('{Escape}')
    await expect.element(confirm).not.toBeInTheDocument()
    expect(history.location.pathname).toBe('/cleanup')
    expect(posted('/free')).toHaveLength(0)

    await free.click()
    await confirm.getByRole('button', {name: `Free ${formatBytes(3.75 * GB)} for good`}).click()
    await expect.poll(() => posted('/free').length).toBe(1)
    expect(history.location.pathname).toBe('/cleanup')
    sendAll(source, freeEvents.slice(0, 3))
    await barSays(screen, 'Freeing ·')
    sendAll(source, freeEvents.slice(3))
    await barSays(screen, `Freed ${formatBytes(4.75 * GB)} · 5 removed`)
    await expect.element(screen.getByText('Freed', {exact: true})).toBeVisible()
    await expect.element(screen.getByText('freed', {exact: true}).first()).toBeVisible()

    await screen.getByRole('button', {name: 'Details'}).click()
    await screen.getByRole('button', {name: 'Watch the movie'}).click()
    await expect.element(movie.getByRole('heading', {name: 'You freed'})).toBeVisible()
    await expect.poll(() => document.querySelector('[data-film="freed"]')?.textContent).toBe(formatBytes(4.75 * GB))
  })

  test('the Free confirm is its own address and is refused when nothing is held', async () => {
    const cold = await openApp('/cleanup/free')
    await expect.poll(() => cold.history.location.pathname).toBe('/cleanup')
    await expect.element(cold.screen.getByRole('dialog')).not.toBeInTheDocument()
  })
})

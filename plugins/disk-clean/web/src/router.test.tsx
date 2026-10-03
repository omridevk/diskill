import type {RouterHistory} from '@tanstack/react-router'
import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import type {Loaded} from './lib/data'
import {at, cleanupEvents, fixture, heldEvents} from './test/fixture'
import {fakeEventSource, mockServer, ringPoints, sendAll} from './test/page'
import './index.css'

type Screen = Awaited<ReturnType<typeof render>>

const details = (screen: Screen) => screen.getByRole('button', {name: 'Details'})

describe('the URL', () => {
  const APPROVED = ['/Users/you/Library/Caches/app-a', '/Users/you/code/web/node_modules']

  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  const where = (history: RouterHistory) => history.location.pathname
  const query = (history: RouterHistory) => Object.fromEntries(new URLSearchParams(history.location.search))
  const planned = () => mockServer()

  async function open(url: string, loaded: Loaded = fixture) {
    const history = at(url)
    const screen = await render(<App loaded={loaded} history={history} />)
    return {history, screen}
  }

  async function reload(screen: Screen, history: RouterHistory, loaded: Loaded = fixture) {
    await screen.unmount()
    return open(history.location.href, loaded)
  }

  const ROUTES: [string, (screen: Screen) => Promise<void>][] = [
    ['/', screen => expect.element(screen.getByRole('heading', {name: 'Application caches'})).toBeVisible()],
    ['/cleanup/node', screen => expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()],
    ['/cleanup?view=cards', screen => expect.element(screen.getByRole('button', {name: 'Card view'})).toHaveAttribute('aria-pressed', 'true')],
    ['/storage/Users/you/Library?shape=treemap', screen => expect.element(screen.getByLabelText('Storage treemap of /Users/you/Library')).toBeVisible()],
    ['/insights', screen => expect.element(screen.getByText('Largest files')).toBeVisible()],
    ['/nowhere', screen => expect.element(screen.getByText('There is no page at this address.')).toBeVisible()],
  ]

  test('every route renders from a cold deep link and again after a reload', async () => {
    for (const [url, shows] of ROUTES) {
      const first = await open(url)
      await shows(first.screen)
      const again = await reload(first.screen, first.history)
      await shows(again.screen)
      await again.screen.unmount()
    }
    const {history, screen} = await open('/')
    await expect.poll(() => where(history)).toBe('/cleanup')
    await screen.unmount()
  })

  test('back and forward walk through tabs, sections, zoom and the confirm modal', async () => {
    planned()
    const {history, screen} = await open('/cleanup')
    await screen.getByRole('link', {name: /^node_modules/}).click()
    await expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()
    expect(where(history)).toBe('/cleanup/node')
    await screen.getByRole('tab', {name: 'Storage'}).click()
    const home = screen.getByLabelText('Storage sunburst of /Users/you')
    await expect.element(home).toBeVisible()
    await userEvent.click(home, {position: ringPoints(home.element())(0.3125, 0).local})
    await expect.element(screen.getByLabelText('Storage sunburst of /Users/you/Library')).toBeVisible()
    expect(where(history)).toBe('/storage/Users/you/Library')

    history.back()
    await expect.element(home).toBeVisible()
    history.back()
    await expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()
    await expect.element(screen.getByRole('tab', {name: 'Cleanup'})).toHaveAttribute('aria-selected', 'true')
    history.back()
    await expect.element(screen.getByRole('heading', {name: 'Application caches'})).toBeVisible()
    history.forward()
    await expect.element(screen.getByRole('heading', {name: 'node_modules'})).toBeVisible()

    await screen.getByRole('button', {name: /^Delete \d+ items? · /}).click()
    const dialog = screen.getByRole('dialog')
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
    expect(where(history)).toBe('/cleanup/confirm')
    history.back()
    await expect.element(dialog).not.toBeInTheDocument()
    expect(where(history)).toBe('/cleanup/node')
    history.forward()
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
  })

  test('filters round-trip through the URL: typing replaces the entry, toggles push one', async () => {
    const {history, screen} = await open('/cleanup')
    const entries = history.length
    await userEvent.type(screen.getByRole('textbox', {name: 'Filter paths'}), 'app')
    await expect.poll(() => query(history).q).toBe('app')
    expect(history.length).toBe(entries)
    await screen.getByRole('button', {name: 'safe', exact: true}).click()
    await expect.poll(() => query(history).risk).toBe('["safe"]')
    expect(history.length).toBe(entries + 1)
    await screen.getByRole('combobox', {name: 'Sort'}).click()
    await screen.getByRole('option', {name: 'Name'}).click()
    await expect.poll(() => query(history).sort).toBe('name-asc')
    await screen.getByRole('button', {name: 'Only selected'}).click()
    await expect.poll(() => query(history).only).toBe('true')
    await screen.getByRole('button', {name: 'Card view'}).click()
    await expect.poll(() => query(history).view).toBe('cards')

    history.back()
    await expect.element(screen.getByRole('button', {name: 'List view'})).toHaveAttribute('aria-pressed', 'true')
    history.forward()
    await expect.element(screen.getByRole('button', {name: 'Card view'})).toHaveAttribute('aria-pressed', 'true')

    const again = await reload(screen, history)
    await expect.element(again.screen.getByRole('textbox', {name: 'Filter paths'})).toHaveValue('app')
    await expect.element(again.screen.getByRole('button', {name: 'safe', exact: true})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(again.screen.getByRole('combobox', {name: 'Sort'})).toMatchTextContent(/Name/)
    await expect.element(again.screen.getByRole('button', {name: 'Only selected'})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(again.screen.getByRole('button', {name: 'Card view'})).toHaveAttribute('aria-pressed', 'true')
    await again.screen.getByRole('button', {name: 'Only selected'}).click()
    await expect.poll(() => query(again.history)).toEqual({q: 'app', risk: '["safe"]', sort: 'name-asc', view: 'cards'})
  })

  test('invalid search values fall back to the defaults without errors', async () => {
    const errors = vi.spyOn(console, 'error')
    const bad = '?view=grid&q=%5B1%5D&risk=%5B%22nope%22%2C%22safe%22%5D&minSize=5&minAge=7&sort=bogus&only=yes&overlay=nope&log=bad&take=-3'
    const {screen} = await open(`/cleanup${bad}`)
    await expect.element(screen.getByRole('button', {name: 'List view'})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(screen.getByRole('textbox', {name: 'Filter paths'})).toHaveValue('')
    await expect.element(screen.getByRole('button', {name: 'safe', exact: true})).toHaveAttribute('aria-pressed', 'true')
    await expect.element(screen.getByRole('button', {name: 'review', exact: true})).toHaveAttribute('aria-pressed', 'false')
    await expect.element(screen.getByRole('combobox', {name: 'Minimum size'})).toMatchTextContent(/Any size/)
    await expect.element(screen.getByRole('combobox', {name: 'Minimum idle time'})).toMatchTextContent(/Any age/)
    await expect.element(screen.getByRole('combobox', {name: 'Sort'})).toMatchTextContent(/Largest first/)
    await expect.element(screen.getByRole('button', {name: 'Only selected'})).toHaveAttribute('aria-pressed', 'false')
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
    await screen.unmount()
    const storage = await open('/storage/no/such/folder?shape=pie')
    await expect.element(storage.screen.getByLabelText('Storage sunburst of /Users/you')).toBeVisible()
    expect(errors).not.toHaveBeenCalled()
  })

  test('the confirm modal opens from the URL and Escape goes back to the list it came from', async () => {
    planned()
    const cold = await open('/cleanup/confirm?q=you')
    const dialog = cold.screen.getByRole('dialog')
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
    expect(window.fetch).toHaveBeenCalledWith('/preview', expect.objectContaining({method: 'POST'}))
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    expect(cold.history.location.href).toBe('/cleanup?q=you')

    await cold.screen.getByRole('link', {name: /^node_modules/}).click()
    await cold.screen.getByRole('button', {name: /^Delete \d+ items? · /}).click()
    await expect.element(dialog.getByText('6 items in total')).toBeVisible()
    expect(cold.history.location.href).toBe('/cleanup/confirm?q=you')
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    expect(cold.history.location.href).toBe('/cleanup/node?q=you')
  })

  test('the Free confirm has its own URL over a held run: Escape goes back, forward and a reload reopen it', async () => {
    mockServer()
    const {source} = fakeEventSource()
    const loaded = {...fixture, approved: APPROVED, openEvents: () => source}
    const {history, screen} = await open('/cleanup?q=you', loaded)
    sendAll(source, heldEvents)
    await screen.getByRole('contentinfo').getByRole('button', {name: 'Free the space now'}).click()
    const dialog = screen.getByRole('dialog', {name: 'Free the space now?'})
    await expect.element(dialog).toBeVisible()
    expect(history.location.href).toBe('/cleanup/free?q=you')
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    expect(history.location.href).toBe('/cleanup?q=you')
    history.forward()
    await expect.element(dialog).toBeVisible()

    const again = await reload(screen, history, loaded)
    sendAll(source, heldEvents)
    await expect.element(again.screen.getByRole('dialog', {name: 'Free the space now?'})).toBeVisible()
    expect(again.history.location.href).toBe('/cleanup/free?q=you')
    await again.screen.unmount()
    const refused = await open('/cleanup/free?q=you')
    await expect.poll(() => refused.history.location.href).toBe('/cleanup?q=you')
  })

  test('the progress panel and the movie open from the URL, and Escape returns to the previous URL', async () => {
    const {source} = fakeEventSource()
    const loaded = {...fixture, approved: APPROVED, openEvents: () => source}
    const {history, screen} = await open('/cleanup?overlay=progress&log=problems', loaded)
    sendAll(source, cleanupEvents)
    const panel = screen.getByRole('dialog', {name: 'Cleanup progress'})
    await expect.element(panel.getByRole('button', {name: 'Problems'})).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => panel.getByRole('listitem').elements().length).toBe(2)
    const entries = history.length
    await panel.getByRole('button', {name: 'Removed'}).click()
    await expect.poll(() => query(history).log).toBe('removed')
    expect(history.length).toBe(entries)
    await userEvent.keyboard('{Escape}')
    await expect.element(panel).not.toBeInTheDocument()
    expect(history.location.href).toBe('/cleanup')

    await details(screen).click()
    await expect.poll(() => query(history).overlay).toBe('progress')
    await screen.getByRole('button', {name: 'Watch the movie'}).click()
    await expect.poll(() => query(history).overlay).toBe('movie')
    const movie = screen.getByRole('dialog', {name: 'Cleanup movie'})
    await expect.element(movie).toBeInTheDocument()
    await expect.poll(() => document.querySelector('[data-film]')?.closest('[data-settled]'), {timeout: 10_000}).not.toBeNull()
    await movie.getByRole('button', {name: 'Replay'}).click()
    await expect.poll(() => query(history).take).toBe('1')
    await userEvent.keyboard('{Escape}')
    await expect.element(movie).not.toBeInTheDocument()
    expect(history.location.href).toBe('/cleanup')
    await expect.element(details(screen)).toHaveFocus()
    history.forward()
    await expect.element(movie).toBeInTheDocument()

    const again = await reload(screen, history, loaded)
    const reopened = again.screen.getByRole('dialog', {name: 'Cleanup movie'})
    await expect.element(reopened).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await expect.element(reopened).not.toBeInTheDocument()
    expect(again.history.location.href).toBe('/cleanup')
  })
})

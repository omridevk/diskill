import type {RouterHistory} from '@tanstack/react-router'
import {gsap} from 'gsap'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {formatBytes, type Platform, type ScanData, type TrashEntry} from './lib/data'
import {at, entry, fixture, trashedEvents} from './test/fixture'
import {fakeEventSource, mockServer, query, sendAll} from './test/page'
import './index.css'

const GB = 1024 ** 3
const DELETE = /^Delete \d+ items? · /
const NOW_TITLE = "Delete immediately? This can't be undone"

type Screen = Awaited<ReturnType<typeof render>>

const posted = (url: string) => vi.mocked(window.fetch).mock.calls.filter(([to]) => String(to) === url)
const palette = (screen: Screen) => screen.getByRole('dialog', {name: 'Command palette'})
const option = (screen: Screen, name: RegExp) => palette(screen).getByRole('option', {name})
const MOD_K = {macos: '{Meta>}k{/Meta}', linux: '{Control>}k{/Control}'}

interface Open {
  url?: string
  platform?: Platform
  trash?: TrashEntry[]
  data?: ScanData
}

async function openApp({url = '/cleanup', platform = 'macos', trash = [], data = fixture.data}: Open = {}) {
  mockServer()
  const {source} = fakeEventSource()
  const history: RouterHistory = at(url)
  const screen = await render(<App loaded={{...fixture, data, trash, platform, openEvents: () => source}} history={history} />)
  await expect.element(screen.getByText('4 items selected · 3.8 GB')).toBeVisible()
  return {screen, source, history}
}

async function aboutDeleting(screen: Screen) {
  await screen.getByRole('button', {name: 'About deleting'}).click()
  const about = screen.getByRole('dialog', {name: 'How Delete works'})
  await expect.element(about).toBeVisible()
  return about
}

describe('the page speaks its platform', () => {
  afterEach(() => vi.restoreAllMocks())

  test('macOS keeps its words and key labels', async () => {
    const {screen} = await openApp()
    const about = await aboutDeleting(screen)
    await expect.element(about.getByText("Delete moves files to the macOS Trash. Undo puts them back; Finder's Put Back works too. Space comes back when the Trash is emptied.")).toBeVisible()
    await expect.element(about.getByText(/^Delete ⌘⌫ · Delete immediately ⌥⌘⌫ or ⇧⌫$/)).toBeVisible()
  })

  test('Linux names the Trash, the file manager and its own keys', async () => {
    const {screen} = await openApp({platform: 'linux'})
    const about = await aboutDeleting(screen)
    await expect.element(about.getByText("Delete moves files to the Trash. Undo puts them back; your file manager's Restore works too. Space comes back when the Trash is emptied.")).toBeVisible()
    await expect.element(about.getByText(/^Delete Ctrl\+⌫ · Delete immediately Shift\+⌫ or Shift\+⌦$/)).toBeVisible()
  })

  test('Linux Trash tab and Empty dialog name the file manager', async () => {
    const {screen} = await openApp({url: '/trash', platform: 'linux', trash: [entry(0, 'trashed'), entry(1, 'put-back')]})
    const list = screen.getByRole('list', {name: 'Items disk-clean moved to the Trash'})
    await expect.element(list.getByText('Restored in the file manager', {exact: true})).toBeVisible()
    await list.getByRole('button', {name: 'Empty…'}).click()
    const confirm = screen.getByRole('dialog', {name: 'Empty these from the Trash?'})
    await expect.element(confirm.getByText(/Undo and your file manager's Restore stop working for them\./)).toBeVisible()
  })

  test('Linux Storage rows and the overcount note', async () => {
    const {screen} = await openApp({url: '/storage', platform: 'linux', data: {...fixture.data, home: 450 * GB, snapshots: 0}})
    await expect.element(screen.getByText('/usr, /var, other users, system-wide caches')).toBeVisible()
    await expect.element(screen.getByText(/^System and reserved space/)).toBeVisible()
    await expect.element(screen.getByText('blocks the filesystem keeps for itself and for root; not user-deletable')).toBeVisible()
    await expect.element(screen.getByText(`du counts ${formatBytes(50 * GB)} more than the disk holds: hard links and reflinked copies share blocks.`)).toBeVisible()
    await expect.element(screen.getByText(/Time Machine/)).not.toBeInTheDocument()
  })

  test('Linux keys: Ctrl+Backspace deletes, Shift+Delete deletes immediately, Ctrl+Alt+Backspace does nothing', async () => {
    const {screen, history} = await openApp({platform: 'linux'})
    await userEvent.click(screen.getByRole('heading', {name: 'Application caches'}))
    await userEvent.keyboard('{Control>}{Alt>}{Backspace}{/Alt}{/Control}')
    expect(history.location.pathname).toBe('/cleanup/caches')
    await userEvent.keyboard('{Meta>}{Backspace}{/Meta}')
    expect(history.location.pathname).toBe('/cleanup/caches')

    await userEvent.keyboard('{Shift>}{Delete}{/Shift}')
    await expect.element(screen.getByRole('dialog', {name: NOW_TITLE})).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()

    await userEvent.keyboard('{Control>}{Backspace}{/Control}')
    await expect.element(screen.getByRole('dialog', {name: 'Move to the Trash'})).toBeVisible()
  })
})

describe('the command palette', () => {
  beforeEach(() => gsap.globalTimeline.timeScale(20))
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
    vi.restoreAllMocks()
  })

  test('Mod+K opens it from the list and from the search box; Escape gives focus back; the address stays', async () => {
    for (const platform of ['macos', 'linux'] as const) {
      const {screen, history} = await openApp({platform})
      const before = history.location.href
      const heading = screen.getByRole('heading', {name: 'Application caches'})
      await userEvent.click(heading)
      await userEvent.keyboard(MOD_K[platform])
      await expect.element(palette(screen)).toBeVisible()
      expect(history.location.href).toBe(before)
      await userEvent.keyboard('{Escape}')
      await expect.element(palette(screen)).not.toBeInTheDocument()

      const search = screen.getByRole('textbox', {name: 'Filter paths'})
      await search.click()
      await userEvent.keyboard(MOD_K[platform])
      await expect.element(palette(screen)).toBeVisible()
      await userEvent.keyboard('{Escape}')
      await expect.element(palette(screen)).not.toBeInTheDocument()
      await expect.element(search).toHaveFocus()
      await screen.unmount()
    }
  })

  test('one Escape with an empty input closes it', async () => {
    const {screen} = await openApp()
    await userEvent.keyboard(MOD_K.macos)
    await expect.element(palette(screen)).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(palette(screen)).not.toBeInTheDocument()
  })

  test('one click outside it closes it', async () => {
    const {screen} = await openApp()
    await userEvent.keyboard(MOD_K.macos)
    await expect.element(palette(screen)).toBeVisible()
    await userEvent.click(palette(screen), {position: {x: 10, y: -40}, force: true})
    await expect.element(palette(screen)).not.toBeInTheDocument()
  })

  test('typing filters, Enter runs the action, shortcuts show on the right', async () => {
    const {screen, history} = await openApp({platform: 'linux'})
    await userEvent.keyboard(MOD_K.linux)
    await expect.element(option(screen, /^Delete 4 items… Ctrl\+⌫$/)).toBeVisible()
    await expect.element(option(screen, /^Select…$/)).toBeVisible()
    await userEvent.keyboard('go to stor')
    await expect.element(option(screen, /^Go to Storage$/)).toBeVisible()
    await expect.element(option(screen, /^Select all shown/)).not.toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    await expect.element(palette(screen)).not.toBeInTheDocument()
    await expect.poll(() => history.location.pathname).toBe('/storage')
  })

  test('Delete… opens the confirm and deletes nothing', async () => {
    const {screen} = await openApp()
    await userEvent.keyboard(MOD_K.macos)
    await userEvent.keyboard('del')
    await expect.element(palette(screen).getByRole('option').first()).toHaveAccessibleName(/^Delete 4 items… /)
    await userEvent.keyboard('{Enter}')
    const confirm = screen.getByRole('dialog', {name: 'Move to the Trash'})
    await expect.element(confirm).toBeVisible()
    expect(posted('/decide')).toHaveLength(0)
    await userEvent.keyboard('{Escape}')
    await expect.element(confirm).not.toBeInTheDocument()
    await userEvent.keyboard(MOD_K.macos)
    await option(screen, /^Delete 4 items immediately…/).click()
    await expect.element(screen.getByRole('dialog', {name: NOW_TITLE})).toBeVisible()
    expect(posted('/decide')).toHaveLength(0)
  })

  test('page shortcuts do not fire while it is open', async () => {
    const {screen, history} = await openApp()
    await userEvent.keyboard(MOD_K.macos)
    await userEvent.keyboard('d{Shift>}{Backspace}{/Shift}')
    await userEvent.keyboard('{Escape}')
    await expect.element(palette(screen)).not.toBeInTheDocument()
    await expect.element(screen.getByText('4 items selected · 3.8 GB')).toBeVisible()
    expect(history.location.pathname).toBe('/cleanup/caches')
  })

  test('Trash actions only on the Trash tab, Undo only after a cleanup', async () => {
    const {screen, source} = await openApp({trash: [entry(0, 'trashed')]})
    await userEvent.keyboard(MOD_K.macos)
    await expect.element(option(screen, /^Filter…/)).toBeVisible()
    await expect.element(option(screen, /^Undo 1 item/)).not.toBeInTheDocument()
    await expect.element(option(screen, /^Undo this cleanup/)).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    await screen.getByRole('tab', {name: 'Trash'}).click()
    await screen.getByRole('checkbox', {name: '~/Library/Caches/app-a'}).click()
    await userEvent.keyboard(MOD_K.macos)
    await expect.element(palette(screen).getByRole('listbox').getByRole('group').first()).toHaveAccessibleName(/^Selected: 1 item · /)
    await expect.element(option(screen, /^Undo 1 item$/)).toBeVisible()
    await expect.element(option(screen, /^Empty 1 item…$/)).toBeVisible()
    await expect.element(option(screen, /^Filter…/)).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    await screen.getByRole('tab', {name: 'Cleanup'}).click()
    await screen.getByRole('button', {name: DELETE}).click()
    await screen.getByRole('dialog').getByRole('button', {name: /^Move 4 items to the Trash/}).click()
    await expect.element(screen.getByRole('button', {name: DELETE})).not.toBeInTheDocument()
    await sendAll(source, trashedEvents)
    await expect.element(screen.getByRole('contentinfo').getByRole('button', {name: 'Undo'})).toBeEnabled()
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
    await userEvent.keyboard(MOD_K.macos)
    await expect.element(option(screen, /^Delete/)).not.toBeInTheDocument()
    await option(screen, /^Cleanup…/).click()
    await expect.element(option(screen, /^Undo this cleanup/)).toBeVisible()
    await expect.element(option(screen, /^Empty these from Trash…/)).toBeVisible()
    await option(screen, /^Empty these from Trash…/).click()
    await expect.element(screen.getByRole('dialog', {name: 'Empty these from the Trash?'})).toBeVisible()
    expect(posted('/empty')).toHaveLength(0)
  })

  test('Enter on Sort by… shows only the orders; choosing one sorts and closes', async () => {
    const {screen, history} = await openApp()
    await userEvent.keyboard(MOD_K.macos)
    await userEvent.keyboard('sort by')
    await expect.element(palette(screen).getByRole('option').first()).toHaveAccessibleName('Sort by…')
    await userEvent.keyboard('{Enter}')
    await expect.element(palette(screen).getByText('Sort by', {exact: true})).toBeVisible()
    await expect.element(palette(screen).getByRole('textbox', {name: 'Command'}).or(palette(screen).getByRole('combobox', {name: 'Command'}))).toHaveValue('')
    expect(palette(screen).getByRole('option').all().map(o => o.element().textContent)).toEqual(['Largest first', 'Smallest first', 'Name', 'Oldest first', 'Newest first'])
    await option(screen, /^Smallest first/).click()
    await expect.element(palette(screen)).not.toBeInTheDocument()
    await expect.poll(() => query(history).sort).toBe('size-asc')
  })

  test('Backspace in the empty input goes back to the top page', async () => {
    const {screen} = await openApp()
    await userEvent.keyboard(MOD_K.macos)
    await option(screen, /^Sort by…/).click()
    await expect.element(option(screen, /^Go to Storage/)).not.toBeInTheDocument()
    await userEvent.keyboard('{Backspace}')
    await expect.element(option(screen, /^Go to Storage/)).toBeVisible()
    await expect.element(palette(screen).getByText('Sort by', {exact: true})).not.toBeInTheDocument()
  })

  test('typing on the top page finds nested actions with their path', async () => {
    const {screen} = await openApp()
    await userEvent.keyboard(MOD_K.macos)
    await userEvent.keyboard('largest')
    await expect.element(option(screen, /^Sort by › Largest first$/)).toBeVisible()
  })

  test('Escape steps back a page, then closes', async () => {
    const {screen} = await openApp()
    await userEvent.keyboard(MOD_K.macos)
    await option(screen, /^Filter…/).click()
    await option(screen, /^Minimum size…/).click()
    await expect.element(palette(screen).getByText('Filter › Minimum size', {exact: true})).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(palette(screen).getByText('Filter', {exact: true})).toBeVisible()
    await expect.element(option(screen, /^Clear filters|^Only selected/).first()).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(option(screen, /^Go to Storage/)).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(palette(screen)).not.toBeInTheDocument()
  })

  test('Filter paths focuses the search box', async () => {
    const {screen} = await openApp()
    await userEvent.keyboard(MOD_K.macos)
    await option(screen, /^Filter paths/).click()
    await expect.element(screen.getByRole('textbox', {name: 'Filter paths'})).toHaveFocus()
  })
})

describe('the palette opens with the selection', () => {
  afterEach(() => vi.restoreAllMocks())

  async function twoTicked() {
    const opened = await openApp()
    await userEvent.click(opened.screen.getByRole('heading', {name: 'Application caches'}))
    await userEvent.keyboard('d')
    await expect.element(opened.screen.getByText('0 items selected', {exact: false})).toBeVisible()
    await opened.screen.getByRole('checkbox', {name: '~/Library/Caches/app-a'}).click()
    await opened.screen.getByRole('checkbox', {name: '~/Library/Caches/app-b'}).click()
    await expect.element(opened.screen.getByText('2 items selected', {exact: false})).toBeVisible()
    return opened
  }

  test('with items ticked the first group is the selection, Delete first', async () => {
    const {screen} = await twoTicked()
    await userEvent.keyboard(MOD_K.macos)
    await expect.element(palette(screen).getByRole('listbox').getByRole('group').first()).toHaveAccessibleName(/^Selected: 2 items · /)
    await expect.element(palette(screen).getByRole('option').first()).toHaveAccessibleName(/^Delete 2 items… /)
    await expect.element(option(screen, /^Delete 2 items immediately…/)).toBeVisible()
    await expect.element(option(screen, /^Show only selected/)).toBeVisible()
    await expect.element(option(screen, /^Clear selection/)).toBeVisible()
  })

  test('Copy 2 paths puts both paths on the clipboard', async () => {
    const {screen} = await twoTicked()
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await userEvent.keyboard(MOD_K.macos)
    await option(screen, /^Copy 2 paths/).click()
    await expect.element(palette(screen)).not.toBeInTheDocument()
    expect(write).toHaveBeenCalledWith('/Users/you/Library/Caches/app-a\n/Users/you/Library/Caches/app-b')
  })

  test('nothing ticked, no selection group', async () => {
    const {screen} = await openApp()
    await userEvent.click(screen.getByRole('heading', {name: 'Application caches'}))
    await userEvent.keyboard('d')
    await userEvent.keyboard(MOD_K.macos)
    await expect.element(option(screen, /^Go to Storage/)).toBeVisible()
    await expect.element(palette(screen).getByText(/^Selected:/)).not.toBeInTheDocument()
    await expect.element(option(screen, /^Copy/)).not.toBeInTheDocument()
  })
})

describe('the shortcut cheatsheet', () => {
  afterEach(() => vi.restoreAllMocks())

  test('? lists the shortcuts that exist here, labelled for the platform', async () => {
    for (const [platform, del, now] of [
      ['macos', '⌘⌫', 'Delete immediately…⌥⌘⌫⇧⌫'],
      ['linux', 'Ctrl+⌫', 'Delete immediately…Shift+⌫Shift+⌦'],
    ] as const) {
      const {screen, history} = await openApp({platform})
      await userEvent.click(screen.getByRole('heading', {name: 'Application caches'}))
      const before = history.location.href
      await userEvent.keyboard('?')
      const sheet = screen.getByRole('dialog', {name: 'Keyboard shortcuts'})
      await expect.element(sheet).toBeVisible()
      expect(history.location.href).toBe(before)
      const row = (name: RegExp) => sheet.getByRole('listitem').filter({hasText: name})
      await expect.element(row(/^Select all shown/)).toHaveTextContent('Select all shownA')
      await expect.element(row(/^Clear selection/)).toHaveTextContent('Clear selectionD')
      await expect.element(row(/^Reset to recommended/)).toHaveTextContent('Reset to recommendedR')
      await expect.element(row(/^Switch to cards view/)).toHaveTextContent('Switch to cards viewV')
      await expect.element(row(/^Filter paths/)).toHaveTextContent('Filter paths/')
      await expect.element(row(/^Delete…[^ ]/)).toHaveTextContent(`Delete…${del}`)
      await expect.element(row(/^Delete immediately…/)).toHaveTextContent(now)
      await expect.element(row(/^Delete… \(in the item list\)/)).toHaveTextContent('Delete… (in the item list)⌫⌦')
      await expect.element(row(/^Command palette/)).toHaveTextContent(`Command palette${platform === 'macos' ? '⌘K' : 'Ctrl+K'}`)
      await expect.element(row(/^Keyboard shortcuts/)).toHaveTextContent('Keyboard shortcuts?')
      await userEvent.keyboard('{Escape}')
      await expect.element(sheet).not.toBeInTheDocument()
      await screen.unmount()
    }
  })

  test('typing ? in the search box types it', async () => {
    const {screen} = await openApp()
    const search = screen.getByRole('textbox', {name: 'Filter paths'})
    await search.click()
    await userEvent.keyboard('?')
    await expect.element(search).toHaveValue('?')
    await expect.element(screen.getByRole('dialog', {name: 'Keyboard shortcuts'})).not.toBeInTheDocument()
  })
})

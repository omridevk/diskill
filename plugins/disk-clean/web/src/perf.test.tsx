import {afterEach, describe, expect, test} from 'vitest'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {bigSection, withSection} from './test/fixture'
import './index.css'

const ROWS = 10_000
const EVENTS = 5_000
const SCROLL_STEPS = 60

interface Timing {
  took: number
  frame: number
  script?: number
}

function nextPaint() {
  return new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
}

function watchFrames() {
  const gaps: number[] = []
  let last = performance.now()
  let watching = true
  const tick = (now: number) => {
    gaps.push(now - last)
    last = now
    if (watching) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return () => {
    watching = false
    return Math.max(0, ...gaps)
  }
}

async function timed(action: () => void): Promise<Timing> {
  await nextPaint()
  const stop = watchFrames()
  const start = performance.now()
  action()
  const script = performance.now() - start
  await nextPaint()
  const took = performance.now() - start
  await nextPaint()
  return {took, frame: stop(), script}
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', {bubbles: true}))
}

function scrollerOf(element: Element) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== 'visible') return node
  }
  throw new Error('no scroll container')
}

function report(name: string, timing: Timing) {
  console.log(`${navigator.userAgent.includes('Firefox') ? 'firefox' : 'chromium'} ${name}: ${timing.took.toFixed(1)} ms (script ${timing.script?.toFixed(1) ?? '-'}), longest frame ${timing.frame.toFixed(1)} ms`)
}

function within(name: string, timing: Timing) {
  report(name, timing)
  expect.soft(timing.took, `${name} interaction`).toBeLessThan(100)
  expect.soft(timing.frame, `${name} frame`).toBeLessThan(50)
}

function button(name: RegExp) {
  const found = [...document.querySelectorAll('button')].find(b => name.test(b.textContent ?? ''))
  if (!found) throw new Error(`no button ${name}`)
  return found
}

function footerText() {
  return document.querySelector('footer')?.textContent ?? ''
}

describe('a 10,000-row section', () => {
  afterEach(() => localStorage.removeItem('disk-clean:view'))

  test('opens, filters, selects all and scrolls within budget', async () => {
    const screen = await render(<App loaded={withSection(bigSection(ROWS))} />)
    await expect.element(screen.getByText('~/Library/Caches/app-a')).toBeVisible()

    within('open section', await timed(() => button(/^Your macOS temp/).click()))
    await expect.element(screen.getByRole('heading', {name: 'Your macOS temp'})).toBeVisible()
    await screen.getByRole('combobox', {name: 'Sort'}).click()
    await screen.getByRole('option', {name: 'Name'}).click()
    await expect.element(screen.getByText('~/tmp/item-00000')).toBeVisible()

    const input = screen.getByRole('textbox', {name: 'Filter paths'}).element()
    if (!(input instanceof HTMLInputElement)) throw new Error('no filter input')
    input.focus()
    for (const typed of ['0', '00', '004', '0042']) within(`type "${typed}"`, await timed(() => typeInto(input, typed)))
    await expect.element(screen.getByText('~/tmp/item-00042')).toBeVisible()
    await expect.element(screen.getByText('~/tmp/item-00001')).not.toBeInTheDocument()
    typeInto(input, '')
    input.blur()
    await expect.element(screen.getByText('~/tmp/item-00001')).toBeVisible()

    const deselect = screen.getByRole('checkbox', {name: 'Select all in Your macOS temp'}).element()
    if (!(deselect instanceof HTMLElement)) throw new Error('no section checkbox')
    within('section checkbox (deselect all)', await timed(() => deselect.click()))
    within('section checkbox (select all)', await timed(() => deselect.click()))
    await expect.poll(footerText).toContain(`${ROWS + 4} items selected`)
    within('shortcut d', await timed(() => document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'd', bubbles: true}))))
    within('shortcut a', await timed(() => document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'a', bubbles: true}))))
    await expect.poll(footerText).toContain(`${ROWS + 6} items selected`)

    const scroller = scrollerOf(screen.getByText('~/tmp/item-00000').element())
    const stop = watchFrames()
    const start = performance.now()
    for (let step = 1; step <= SCROLL_STEPS; step++) {
      scroller.scrollTop += scroller.clientHeight
      await nextPaint()
    }
    within('scroll a page per frame', {took: (performance.now() - start) / SCROLL_STEPS, frame: stop()})
    within('jump to the end', await timed(() => (scroller.scrollTop = scroller.scrollHeight)))
    await expect.element(screen.getByText('~/tmp/item-09999')).toBeVisible()
    await expect.element(screen.getByText('~/tmp/item-00000')).not.toBeInTheDocument()
  }, 180_000)
})

function cleanupSource() {
  return Object.assign(new EventTarget(), {readyState: 1, close: () => {}})
}

function send(source: EventTarget, type: string, data: object) {
  source.dispatchEvent(new MessageEvent(type, {data: JSON.stringify(data)}))
}

function stream(source: EventTarget, paths: readonly string[], perTick: number) {
  return new Promise<void>(resolve => {
    let next = 0
    const tick = () => {
      for (const path of paths.slice(next, next + perTick)) send(source, 'removed', {path, bytes: 4096, secs: 0.01, elapsed_ms: 1000 + next})
      next += perTick
      if (next < paths.length) setTimeout(tick, 16)
      else resolve()
    }
    tick()
  })
}

describe('a 5,000-event cleanup', () => {
  test('keeps frames under 50 ms with the progress panel open', async () => {
    const loaded = withSection(bigSection(EVENTS))
    const paths = loaded.data.categories.flatMap(c => c.items.filter(i => i.path.includes('/tmp/')).map(i => i.path))
    const source = cleanupSource()
    const screen = await render(<App loaded={{...loaded, approved: paths, openEvents: () => source}} />)
    await screen.getByRole('button', {name: /^Your macOS temp/}).click()
    await expect.element(screen.getByRole('heading', {name: 'Your macOS temp'})).toBeVisible()
    send(source, 'started', {free: 1, paths: paths.length, worktrees: 0, commands: 0, bytes: paths.length * 4096, elapsed_ms: 0})
    await screen.getByRole('button', {name: 'Details'}).click()
    const panel = screen.getByRole('dialog', {name: 'Cleanup progress'})
    await expect.element(panel).toBeVisible()
    const stop = watchFrames()
    await stream(source, paths, 25)
    await expect.poll(() => document.querySelector('header p')?.textContent).toContain(`${EVENTS} of ${EVENTS}`)
    await nextPaint()
    const frame = stop()
    report('cleanup stream', {took: 0, frame})
    expect(frame).toBeLessThan(50)
    await expect.element(panel.getByText('Removed ~/tmp/item-04999')).toBeVisible()
    await expect.element(panel.getByText(/older rows not shown/)).not.toBeInTheDocument()
    const log = scrollerOf(panel.getByText('Removed ~/tmp/item-04999').element())
    log.scrollTop = log.scrollHeight
    await expect.element(panel.getByText('Removed ~/tmp/item-00000')).toBeVisible()
    expect(panel.getByRole('listitem').elements().length).toBeLessThan(60)
  }, 180_000)
})

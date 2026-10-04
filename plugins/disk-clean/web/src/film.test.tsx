import {gsap} from 'gsap'
import {useEffect, useState} from 'react'
import {flushSync} from 'react-dom'
import {afterEach, beforeEach, describe, expect, test} from 'vitest'
import {page, userEvent} from 'vitest/browser'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {CleanupFilm} from './components/cleanup-film'
import type {CleanupEvent} from './lib/cleanup-feed'
import {formatBytes} from './lib/data'
import {createDb, receiveCleanupEvents, type Db} from './lib/db'
import {useMovie} from './lib/progress'
import {at, cleanupEvents, fixture} from './test/fixture'
import './index.css'

const GB = 1024 ** 3
const MB = 1024 ** 2
const STREAM_CHUNK = 10
const selected = fixture.data.categories.flatMap(c => c.items.filter(i => i.preselect))

function movieDb(events: readonly CleanupEvent[] = []) {
  const db = createDb({...fixture, approved: selected.map(i => i.path)})
  receiveCleanupEvents(db, events)
  return db
}

function Movie({db}: {db: Db}) {
  const [take, setTake] = useState(0)
  const movie = useMovie(db)
  return <CleanupFilm {...movie} open take={take} onReplay={() => setTake(take + 1)} onClose={() => {}} />
}

const finishedEvents = cleanupEvents as readonly CleanupEvent[]

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

function particleCanvas() {
  return document.querySelector<HTMLCanvasElement>('[data-film="particles"] canvas')
}

function film(name: string) {
  return document.querySelector<HTMLElement>(`[data-film="${name}"]`)
}

function visibility(name: string) {
  const el = film(name)
  return el ? getComputedStyle(el).visibility : 'none'
}

function inkBox(pixels: Uint8ClampedArray, width: number, lit: (i: number) => boolean) {
  const box = {left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity}
  for (let i = 0; i < pixels.length; i += 4) {
    if (!lit(i)) continue
    const x = (i / 4) % width
    const y = Math.floor(i / 4 / width)
    box.left = Math.min(box.left, x)
    box.right = Math.max(box.right, x + 1)
    box.top = Math.min(box.top, y)
    box.bottom = Math.max(box.bottom, y + 1)
  }
  return box
}

function toPage(box: Box, origin: DOMRect, scale: number): Box {
  return {left: origin.left + box.left / scale, right: origin.left + box.right / scale, top: origin.top + box.top / scale, bottom: origin.top + box.bottom / scale}
}

function particleBox(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no particle context')
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  const rect = canvas.getBoundingClientRect()
  return toPage(
    inkBox(pixels, canvas.width, i => (pixels[i + 3] ?? 0) >= 128),
    rect,
    canvas.width / rect.width,
  )
}

async function domBox(figure: HTMLElement) {
  const shot = await page.screenshot({element: figure, save: false})
  const image = new Image()
  image.src = `data:image/png;base64,${shot}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no screenshot context')
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  const rect = figure.getBoundingClientRect()
  return toPage(
    inkBox(pixels, canvas.width, i => (pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0) > 600),
    rect,
    canvas.width / rect.width,
  )
}

function handoff(figure: HTMLElement) {
  return new Promise<{frame: number; landed: Box}>(resolve => {
    const frames: number[] = []
    let last = 0
    const tick = (now: number) => {
      if (last) frames.push(now - last)
      last = now
      const canvas = particleCanvas()
      if (!canvas || Number(getComputedStyle(figure).opacity) === 0) return requestAnimationFrame(tick)
      frames.sort((a, b) => a - b)
      resolve({frame: frames[Math.floor(frames.length / 2)] ?? Infinity, landed: particleBox(canvas)})
    }
    requestAnimationFrame(tick)
  })
}

function centre(box: Box) {
  return {x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2}
}

function quickLog(count: number): CleanupEvent[] {
  const removed: CleanupEvent[] = Array.from({length: count}, (_, i) => ({
    type: 'removed',
    data: {path: `/Users/you/Library/Caches/quick-${i}`, bytes: 2 * MB, secs: 0.01, elapsed_ms: 1 + i * 30},
  }))
  return [
    {type: 'started', data: {run: 'run-1', free: 50 * GB, paths: count, worktrees: 0, commands: 0, bytes: count * 2 * MB, elapsed_ms: 0}},
    ...removed,
    {type: 'done', data: {free_before: 50 * GB, free_after: 50 * GB + count * 2 * MB, elapsed_ms: 1000}},
  ]
}

async function renderFinished(scale = 4) {
  gsap.globalTimeline.timeScale(scale)
  return render(<Movie db={movieDb(finishedEvents)} />)
}

function settledIn(screen: Awaited<ReturnType<typeof render>>) {
  return expect.poll(() => document.querySelector('[data-settled]'), {timeout: 20_000}).not.toBeNull()
}

interface Sample {
  items: number
  ms: number
}

function Streamed({log, steps}: {log: readonly CleanupEvent[]; steps: Sample[]}) {
  const [cleanup] = useState(() => movieDb())
  useEffect(() => {
    let sent = 0
    let frame = 0
    const step = () => {
      const next = log.slice(sent, sent + STREAM_CHUNK)
      sent += next.length
      const start = performance.now()
      flushSync(() => receiveCleanupEvents(cleanup, next))
      steps.push({items: sent, ms: performance.now() - start})
      if (sent < log.length) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [log, steps, cleanup])
  return <Movie db={cleanup} />
}

function timeTicks(into: Sample[], items: () => number) {
  let start = 0
  const open = () => {
    start = performance.now()
  }
  const close = () => {
    into.push({items: items(), ms: performance.now() - start})
  }
  gsap.ticker.add(open, false, true)
  gsap.ticker.add(close)
  return () => {
    gsap.ticker.remove(open)
    gsap.ticker.remove(close)
  }
}

function leastWork(samples: readonly Sample[], from: number, to: number) {
  const work = samples.filter(s => s.items > from && s.items <= to).map(s => s.ms)
  return work.toSorted((a, b) => a - b)[Math.floor(work.length / 10)] ?? Infinity
}

async function streamWork(count: number) {
  const steps: Sample[] = []
  const ticks: Sample[] = []
  const stop = timeTicks(ticks, () => steps.at(-1)?.items ?? 0)
  const screen = await render(<Streamed log={quickLog(count)} steps={steps} />)
  await expect.poll(() => visibility('finale'), {timeout: 40_000}).toBe('visible')
  stop()
  await screen.unmount()
  return {steps, ticks}
}

describe('the cleanup movie', () => {
  beforeEach(() => {
    document.documentElement.classList.add('dark')
  })
  afterEach(() => {
    document.documentElement.classList.remove('dark')
    gsap.globalTimeline.timeScale(1)
  })

  test('at real speed the particles land on the DOM figure before it fades in over them', async () => {
    const screen = await render(<Movie db={movieDb(finishedEvents)} />)
    await expect.poll(particleCanvas, {timeout: 15_000}).not.toBeNull()
    const figure = film('freed')
    if (!figure) throw new Error('no finale figure')
    const {frame, landed} = await handoff(figure)
    expect(frame).toBeLessThan(34)
    await expect.poll(particleCanvas, {timeout: 5_000}).toBeNull()
    const text = await domBox(figure)
    const [a, b] = [centre(landed), centre(text)]
    expect(Math.abs(a.x - b.x), `frame ${frame} centre x ${JSON.stringify(landed)} vs ${JSON.stringify(text)}`).toBeLessThanOrEqual(1.5)
    expect(Math.abs(a.y - b.y), `centre y ${a.y} vs ${b.y}`).toBeLessThanOrEqual(1.5)
    for (const side of ['left', 'right', 'top', 'bottom'] as const) expect(Math.abs(landed[side] - text[side]), `${side} ${landed[side]} vs ${text[side]}`).toBeLessThanOrEqual(2.5)
    await expect.element(screen.getByRole('heading', {name: 'You freed'})).toBeVisible()
    expect(figure.textContent).toBe(formatBytes(3.5 * GB))
  }, 30_000)

  test('a cleanup that took a second still plays back as several beats over the minimum length', async () => {
    gsap.globalTimeline.timeScale(4)
    const quick = movieDb(quickLog(30))
    const labels = new Set<string>()
    const watch = new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-film="card"] [data-part="label"]')) if (el.textContent) labels.add(el.textContent)
    })
    watch.observe(document.body, {subtree: true, childList: true, characterData: true})
    let counted = 0
    let shown = 0
    const counter = new MutationObserver(() => {
      counted = performance.now()
    })
    const finale = new MutationObserver(() => {
      if (!shown && visibility('finale') === 'visible') shown = performance.now()
    })
    await render(<Movie db={quick} />)
    await expect.poll(() => visibility('stage'), {timeout: 10_000}).toBe('visible')
    const start = performance.now()
    counter.observe(film('counter') ?? document.body, {subtree: true, childList: true, characterData: true})
    finale.observe(film('finale') ?? document.body, {attributes: true, attributeFilter: ['style']})
    await expect.poll(() => shown, {timeout: 20_000}).toBeGreaterThan(0)
    const deleting = ((shown - start) / 1000) * 4
    watch.disconnect()
    counter.disconnect()
    finale.disconnect()
    expect(deleting).toBeGreaterThanOrEqual(6)
    expect(labels.size).toBeGreaterThanOrEqual(20)
    expect(((shown - counted) / 1000) * 4, 'film seconds between the last count and the finale').toBeLessThan(1)
    expect(film('trays')).toBeNull()
  }, 30_000)

  test('Replay starts the film over at normal speed and plays it to the same finale', async () => {
    const screen = await renderFinished()
    await settledIn(screen)
    const shader = document.querySelector('[data-film="film"] canvas')
    for (const take of [1, 2]) {
      await screen.getByRole('button', {name: 'Replay'}).click()
      expect(visibility('finale'), `take ${take} hides the finale`).toBe('hidden')
      expect(film('counter')?.textContent).toBe('0 B')
      await expect.poll(() => visibility('stage')).toBe('visible')
      await settledIn(screen)
      await expect.element(screen.getByRole('heading', {name: 'You freed'})).toBeVisible()
      expect(film('counter')?.textContent).toBe(formatBytes(3.5 * GB))
      expect(particleCanvas()).toBeNull()
      expect(document.querySelector('[data-film="film"] canvas'), 'the backdrop keeps its WebGL canvas').toBe(shader)
    }
  }, 60_000)

  test('the credits can be scrolled during the roll and after it', async () => {
    const screen = await renderFinished()
    const credits = () => film('credits') ?? document.body
    await expect.poll(() => credits().scrollTop, {timeout: 20_000}).toBeGreaterThan(10)
    await userEvent.wheel(page.elementLocator(credits()), {delta: {y: 40}})
    await expect.poll(() => document.querySelector('[data-settled]')).not.toBeNull()
    await new Promise(r => setTimeout(r, 800))
    const held = credits().scrollTop
    await new Promise(r => setTimeout(r, 500))
    expect(credits().scrollTop).toBe(held)
    await userEvent.wheel(page.elementLocator(credits()), {delta: {y: -400}})
    await expect.poll(() => credits().scrollTop).toBe(0)
  }, 30_000)

  test('after the roll the credits list is a normal scroll list', async () => {
    const screen = await renderFinished()
    await settledIn(screen)
    const credits = film('credits') ?? document.body
    const end = credits.scrollTop
    expect(end).toBe(credits.scrollHeight - credits.clientHeight)
    await userEvent.wheel(page.elementLocator(credits), {delta: {y: -100}})
    await expect.poll(() => credits.scrollTop).toBeLessThan(end)
    credits.focus()
    expect(document.activeElement).toBe(credits)
    await userEvent.keyboard('{Home}')
    await expect.poll(() => credits.scrollTop).toBe(0)
  }, 30_000)

  test('the disk gauge stays on screen and says what it measures', async () => {
    const screen = await renderFinished(1)
    await expect.poll(() => visibility('stage'), {timeout: 10_000}).toBe('visible')
    const stage = film('gauge-used')?.closest('[data-film="build"]')
    if (!(stage instanceof HTMLElement)) throw new Error('no stage gauge')
    const box = stage.getBoundingClientRect()
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(innerWidth)
    expect(box.bottom).toBeLessThanOrEqual(innerHeight)
    expect(stage.textContent).toContain(`Free space${formatBytes(50 * GB)} → `)
    gsap.globalTimeline.timeScale(4)
    await settledIn(screen)
    const end = film('bars')
    expect(end?.textContent).toContain(`${formatBytes(3.5 * GB)} removed`)
    expect(end?.textContent).toContain(`free space ${formatBytes(50 * GB)} → ${formatBytes(53.4 * GB)}`)
    expect(end?.textContent).toContain('too small to see at true scale')
    const shown = film('gauge-after')
    expect(Number(shown?.dataset.from) - Number(shown?.dataset.to)).toBeGreaterThan(0.01)
  }, 40_000)

  test('only stat tiles with details open, in a popover, and the grid never grows', async () => {
    const screen = await renderFinished()
    await settledIn(screen)
    const grid = document.querySelector('[data-film="tile"]')?.parentElement
    if (!grid) throw new Error('no tiles')
    const size = () => `${grid.getBoundingClientRect().width}x${grid.getBoundingClientRect().height}`
    const before = size()
    await screen.getByText('removed for good').click()
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
    expect(size()).toBe(before)
    await screen.getByRole('button', {name: /not removed/}).click()
    const popover = page.getByRole('dialog', {name: 'not removed'})
    await expect.element(popover).toBeVisible()
    await expect.element(popover).toHaveTextContent('~/Library/Caches/app-dstill present after removal: permission denied')
    expect(size()).toBe(before)
  }, 30_000)

  test('the movie traps focus and gives it back to Details when it closes', async () => {
    const source = Object.assign(new EventTarget(), {readyState: 1, close: () => {}})
    const approved = selected.map(i => i.path)
    const screen = await render(<App loaded={{...fixture, approved, openEvents: () => source}} history={at()} />)
    for (const event of cleanupEvents) source.dispatchEvent(new MessageEvent(event.type, {data: JSON.stringify(event.data)}))
    const details = screen.getByRole('button', {name: 'Details'})
    await details.click()
    await page.getByRole('button', {name: 'Watch the movie'}).click()
    const movie = page.getByRole('dialog', {name: 'Cleanup movie'})
    await expect.element(movie).toBeInTheDocument()
    for (let i = 0; i < 4; i++) {
      await userEvent.keyboard('{Tab}')
      await expect.poll(() => document.activeElement?.closest('[aria-label="Cleanup movie"]')).not.toBeNull()
    }
    await userEvent.keyboard('{Escape}')
    await expect.element(movie).not.toBeInTheDocument()
    await expect.element(details).toHaveFocus()
  }, 30_000)

  test('a cleanup that removed nothing ends on what happened, not on a celebration', async () => {
    gsap.globalTimeline.timeScale(4)
    const failed = movieDb([
      {type: 'started', data: {run: 'run-1', free: 50 * GB, paths: 2, worktrees: 0, commands: 1, bytes: 2 * GB, elapsed_ms: 0}},
      {type: 'failed', data: {path: '/Users/you/Library/Caches/app-a', bytes: 2 * GB, reason: 'Operation not permitted', elapsed_ms: 10}},
      {type: 'command', data: {id: 'brew', label: 'brew cleanup', status: 'failed', elapsed_ms: 20}},
      {type: 'done', data: {free_before: 50 * GB, free_after: 50 * GB, elapsed_ms: 30}},
    ])
    const screen = await render(<Movie db={failed} />)
    await settledIn(screen)
    await expect.element(screen.getByRole('heading', {name: 'Nothing could be removed'})).toBeVisible()
    expect(film('freed')?.textContent).toBe('2 not removed')
    expect(document.body.textContent).not.toContain('brew cleanup failed')
  }, 30_000)

  test('a done that arrives without a start still ends the film', async () => {
    gsap.globalTimeline.timeScale(4)
    const orphan = movieDb([{type: 'done', data: {free_before: 50 * GB, free_after: 50 * GB, elapsed_ms: 5}}])
    const screen = await render(<Movie db={orphan} />)
    await settledIn(screen)
    await expect.element(screen.getByRole('heading', {name: 'Nothing was removed'})).toBeVisible()
  }, 30_000)

  test('a cleanup that never started ends on why, not on a celebration', async () => {
    gsap.globalTimeline.timeScale(4)
    const never = movieDb([
      {type: 'waiting', data: {}},
      {type: 'abandoned', data: {reason: 'clean was never run after the approval'}},
    ])
    const screen = await render(<Movie db={never} />)
    await settledIn(screen)
    await expect.element(screen.getByRole('heading', {name: 'The cleanup did not start'})).toBeVisible()
    expect(film('freed')?.textContent).toBe('clean was never run after the approval')
    expect(visibility('finale')).toBe('visible')
    expect(getComputedStyle(film('waiting') ?? document.body).opacity).toBe('0')
    expect(particleCanvas()).toBeNull()
  }, 30_000)

  test('a cleanup that stopped halfway ends on what it freed and what it kept', async () => {
    gsap.globalTimeline.timeScale(4)
    const stopped = movieDb([
      cleanupEvents[1],
      cleanupEvents[2],
      {type: 'kept', data: {path: '/Users/you/Library/Caches/app-b', bytes: GB, reason: 'it changed after the approval', elapsed_ms: 1200}},
      {type: 'abandoned', data: {reason: 'the cleanup process exited before it finished'}},
    ])
    const screen = await render(<Movie db={stopped} />)
    await settledIn(screen)
    await expect.element(screen.getByRole('heading', {name: 'The cleanup stopped before it finished'})).toBeVisible()
    expect(film('freed')?.textContent).toBe(`the cleanup process exited before it finished · freed ${formatBytes(2 * GB)}`)
    expect(particleCanvas()).toBeNull()
    await screen.getByRole('button', {name: /kept/}).click()
    await expect.element(screen.getByRole('dialog', {name: 'kept'}).getByText('it changed after the approval')).toBeVisible()
  }, 30_000)

  test('the shredder never cuts through the caption, and cards stay in their column at narrow widths', async () => {
    const size = [innerWidth, innerHeight] as const
    await page.viewport(1024, 760)
    gsap.globalTimeline.timeScale(2)
    let caption = -1
    const watch = new MutationObserver(() => {
      if (caption < 0 && document.querySelector('[data-film="slot"] canvas')) caption = Number(getComputedStyle(film('caption') ?? document.body).opacity)
    })
    watch.observe(document.body, {subtree: true, childList: true})
    await render(<Movie db={movieDb(finishedEvents)} />)
    await expect.poll(() => caption, {timeout: 15_000}).toBeGreaterThanOrEqual(0)
    watch.disconnect()
    expect(caption).toBe(0)
    const list = film('stage')?.querySelector('ol')?.getBoundingClientRect()
    const slot = film('slot')?.getBoundingClientRect()
    expect(slot && list && slot.left >= list.right).toBe(true)
    await page.viewport(...size)
  }, 30_000)

  test('streaming 3000 removals costs as little work per frame at the end as in the first 300', async () => {
    gsap.globalTimeline.timeScale(4)
    const work = await streamWork(3000)
    for (const [name, samples] of Object.entries(work)) {
      const first = leastWork(samples, 0, 300)
      const last = leastWork(samples, 2700, Infinity)
      expect.soft(last, `${name}: ${last.toFixed(2)} ms of work per frame at 3000 items against ${first.toFixed(2)} ms in the first 300`).toBeLessThan(first * 2 + 2)
    }
  }, 90_000)

  test('waiting for Claude only animates compositor properties', async () => {
    const source = Object.assign(new EventTarget(), {readyState: 1, close: () => {}})
    const approved = selected.map(i => i.path)
    const screen = await render(<App loaded={{...fixture, approved, openEvents: () => source}} history={at()} />)
    source.dispatchEvent(new MessageEvent('waiting', {data: '{}'}))
    await expect.element(screen.getByText('Claude is showing the commands', {exact: false}).first()).toBeInTheDocument()
    const animated = document.getAnimations().flatMap(a => (a.effect instanceof KeyframeEffect ? a.effect.getKeyframes().flatMap(Object.keys) : []))
    const painted = animated.filter(p => !['offset', 'computedOffset', 'easing', 'composite', 'opacity', 'transform'].includes(p))
    expect(animated).toContain('opacity')
    expect(painted).toEqual([])
  })
})

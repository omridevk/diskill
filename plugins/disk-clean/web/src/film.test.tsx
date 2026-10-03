import {gsap} from 'gsap'
import {afterEach, describe, expect, test} from 'vitest'
import {render} from 'vitest-browser-react'
import {App} from './App'
import {CleanupFilm} from './components/cleanup-film'
import {cleanupReducer, filmPlan, NO_CLEANUP, type CleanupEvent} from './lib/cleanup'
import {formatBytes} from './lib/data'
import {cleanupEvents, fixture} from './test/fixture'
import './index.css'

const GB = 1024 ** 3
const selected = fixture.data.categories.flatMap(c => c.items.filter(i => i.preselect))
const plan = filmPlan(fixture.data.categories, selected, 3.75 * GB, 500 * GB)
const finished = cleanupReducer(NO_CLEANUP, cleanupEvents as readonly CleanupEvent[])

function particleCanvas() {
  return document.querySelector<HTMLCanvasElement>('[data-film="particles"] canvas')
}

interface Area {
  left: number
  right: number
  top: number
  bottom: number
}

function canvasArea(canvas: HTMLCanvasElement, figure: Element): Area {
  const box = canvas.getBoundingClientRect()
  const text = figure.getBoundingClientRect()
  const scale = canvas.width / box.width
  return {left: (text.left - box.left) * scale, right: (text.right - box.left) * scale, top: (text.top - box.top) * scale, bottom: (text.bottom - box.top) * scale}
}

function within(x: number, y: number, area: Area) {
  return x >= area.left && x <= area.right && y >= area.top && y <= area.bottom
}

function gatheredShare(canvas: HTMLCanvasElement, figure: Element) {
  const context = canvas.getContext('2d')
  if (!context) return 0
  const area = canvasArea(canvas, figure)
  const alpha = context.getImageData(0, 0, canvas.width, canvas.height).data.filter((_, i) => i % 4 === 3)
  let lit = 0
  let inside = 0
  alpha.forEach((value, p) => {
    if (value < 64) return
    lit++
    if (within(p % canvas.width, Math.floor(p / canvas.width), area)) inside++
  })
  return lit > 0 ? inside / lit : 0
}

function watchParticles(figure: Element) {
  return new Promise<{frame: number; gathered: number}>(resolve => {
    const frames: number[] = []
    let last = 0
    let gathered = 0
    const sample = setInterval(() => {
      const canvas = particleCanvas()
      if (canvas) gathered = Math.max(gathered, gatheredShare(canvas, figure))
    }, 100)
    const tick = (now: number) => {
      if (last) frames.push(now - last)
      last = now
      if (particleCanvas()) return requestAnimationFrame(tick)
      clearInterval(sample)
      frames.sort((a, b) => a - b)
      resolve({frame: frames[Math.floor(frames.length / 2)] ?? Infinity, gathered})
    }
    requestAnimationFrame(tick)
  })
}

function finale() {
  const el = document.querySelector('[data-film="finale"]')
  return el ? getComputedStyle(el).visibility : 'none'
}

describe('the cleanup movie', () => {
  afterEach(() => {
    gsap.globalTimeline.timeScale(1)
  })

  test('at real speed the particles gather into the reclaimed figure before it is swapped in', async () => {
    const screen = await render(<CleanupFilm plan={plan} cleanup={finished} onClose={() => {}} />)
    await expect.poll(particleCanvas, {timeout: 10_000}).not.toBeNull()
    const figure = screen.container.querySelector('[data-film="freed"]')
    if (!figure) throw new Error('no finale figure')
    const {frame, gathered} = await watchParticles(figure)
    expect(frame).toBeLessThan(34)
    expect(gathered).toBeGreaterThan(0.85)
    await expect.element(screen.getByRole('heading', {name: 'You freed'})).toBeVisible()
    expect(figure.textContent).toBe(formatBytes(3.5 * GB))
    expect(getComputedStyle(figure).opacity).toBe('1')
  }, 20_000)

  test('a finished cleanup plays back as beats, not one catch-up flood', async () => {
    gsap.globalTimeline.timeScale(4)
    const screen = await render(<CleanupFilm plan={plan} cleanup={finished} onClose={() => {}} />)
    const labels = () => [...screen.container.querySelectorAll('[data-film="card"] [data-part="label"]')].map(el => el.textContent)
    await expect.poll(labels, {timeout: 10_000}).toContain('~/Library/Caches/app-b')
  })

  test('Replay starts the film over and plays it to the same finale', async () => {
    gsap.globalTimeline.timeScale(4)
    const screen = await render(<CleanupFilm plan={plan} cleanup={finished} onClose={() => {}} />)
    const settled = () => screen.container.querySelector('[data-settled]')
    await expect.poll(settled, {timeout: 15_000}).not.toBeNull()
    for (const take of [1, 2]) {
      await screen.getByRole('button', {name: 'Replay'}).click()
      expect(finale(), `take ${take} hides the finale`).toBe('hidden')
      expect(screen.container.querySelector('[data-film="counter"]')?.textContent).toBe('0 B')
      await expect.poll(() => getComputedStyle(screen.container.querySelector('[data-film="stage"]') ?? document.body).visibility).toBe('visible')
      await expect.poll(settled, {timeout: 15_000}).not.toBeNull()
      await expect.element(screen.getByRole('heading', {name: 'You freed'})).toBeVisible()
      expect(screen.container.querySelector('[data-film="counter"]')?.textContent).toBe(formatBytes(3.5 * GB))
      expect(particleCanvas()).toBeNull()
    }
  }, 60_000)

  test('waiting for Claude only animates compositor properties', async () => {
    const source = Object.assign(new EventTarget(), {readyState: 1, close: () => {}})
    const approved = selected.map(i => i.path)
    const screen = await render(<App loaded={{...fixture, approved, openEvents: () => source}} />)
    source.dispatchEvent(new MessageEvent('waiting', {data: '{}'}))
    await expect.element(screen.getByText('Approved · Claude is showing the commands in your terminal').first()).toBeInTheDocument()
    const animated = document.getAnimations().flatMap(a => (a.effect instanceof KeyframeEffect ? a.effect.getKeyframes().flatMap(Object.keys) : []))
    const painted = animated.filter(p => !['offset', 'computedOffset', 'easing', 'composite', 'opacity', 'transform'].includes(p))
    expect(animated).toContain('opacity')
    expect(painted).toEqual([])
  })
})

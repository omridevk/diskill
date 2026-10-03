import {useEffect, useRef, useState} from 'react'
import {useReducedMotion} from './motion'

export interface Renderer {
  resize: (width: number, height: number, dpr: number) => void
  frame: (now: number) => void
  still: () => void
  dispose: () => void
}

export type CreateRenderer = (canvas: HTMLCanvasElement) => Renderer | null

const MAX_DPR = 1.5

function fit(canvas: HTMLCanvasElement, renderer: Renderer, scale: number) {
  renderer.resize(canvas.clientWidth, canvas.clientHeight, Math.min(window.devicePixelRatio || 1, MAX_DPR) * scale)
}

function drawStill(canvas: HTMLCanvasElement, renderer: Renderer, scale: number) {
  const size = new ResizeObserver(() => {
    fit(canvas, renderer, scale)
    renderer.still()
  })
  size.observe(canvas)
  return () => size.disconnect()
}

function runLoop(canvas: HTMLCanvasElement, renderer: Renderer, scale: number) {
  let frame = 0
  let onScreen = true
  const tick = (now: number) => {
    renderer.frame(now)
    frame = requestAnimationFrame(tick)
  }
  const sync = () => {
    cancelAnimationFrame(frame)
    frame = onScreen && !document.hidden ? requestAnimationFrame(tick) : 0
  }
  const sight = new IntersectionObserver(entries => {
    onScreen = entries.at(-1)?.isIntersecting ?? true
    sync()
  })
  const size = new ResizeObserver(() => fit(canvas, renderer, scale))
  sight.observe(canvas)
  size.observe(canvas)
  document.addEventListener('visibilitychange', sync)
  fit(canvas, renderer, scale)
  sync()
  return () => {
    cancelAnimationFrame(frame)
    sight.disconnect()
    size.disconnect()
    document.removeEventListener('visibilitychange', sync)
  }
}

function mountCanvas(host: HTMLElement) {
  const canvas = document.createElement('canvas')
  canvas.className = 'block size-full'
  canvas.setAttribute('aria-hidden', 'true')
  host.append(canvas)
  return canvas
}

export function useCanvasRenderer(create: CreateRenderer, scale = 1) {
  const host = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!host.current) return
    const canvas = mountCanvas(host.current)
    const renderer = create(canvas)
    if (!renderer) {
      canvas.remove()
      return setFailed(true)
    }
    const stop = reduced ? drawStill(canvas, renderer, scale) : runLoop(canvas, renderer, scale)
    return () => {
      stop()
      renderer.dispose()
      canvas.remove()
    }
  }, [create, reduced, scale])
  return {host, failed}
}

import {useEffect, useLayoutEffect, useRef, useState} from 'react'

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function cssValue(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function cssNumber(name: string, fallback: number) {
  return parseFloat(cssValue(name)) || fallback
}

export function cssMs(name: string, fallback: number) {
  const value = cssValue(name)
  const number = parseFloat(value)
  if (Number.isNaN(number)) return fallback
  return value.endsWith('ms') ? number : number * 1000
}

function reflow(el: HTMLElement) {
  return el.offsetHeight
}

function useOnChange<T extends HTMLElement>(value: unknown, run: (el: T) => void) {
  const ref = useRef<T>(null)
  const last = useRef(value)
  useLayoutEffect(() => {
    if (!ref.current || Object.is(last.current, value)) return
    last.current = value
    run(ref.current)
  }, [value, run])
  return ref
}

function replayDigits(group: HTMLElement) {
  group.classList.remove('is-animating')
  reflow(group)
  group.classList.add('is-animating')
}

function replayPanel(panel: HTMLElement) {
  panel.dataset.open = 'false'
  reflow(panel)
  panel.dataset.open = 'true'
}

export function usePopIn(value: string) {
  return useOnChange<HTMLSpanElement>(value, replayDigits)
}

export function useReveal(key: string) {
  return useOnChange<HTMLDivElement>(key, replayPanel)
}

export function useShownOnMount() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const block = ref.current
    if (!block) return
    block.classList.remove('is-hiding', 'is-shown')
    reflow(block)
    block.classList.add('is-shown')
  }, [])
  return ref
}

export function useTextSwap(text: string) {
  const ref = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(text)
  useEffect(() => {
    const el = ref.current
    if (text === shown || !el) return
    if (prefersReducedMotion()) return setShown(text)
    el.classList.add('is-exit')
    const timer = setTimeout(() => setShown(text), cssMs('--text-swap-dur', 150))
    return () => clearTimeout(timer)
  }, [text, shown])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el?.classList.contains('is-exit')) return
    el.classList.remove('is-exit')
    el.classList.add('is-enter-start')
    reflow(el)
    el.classList.remove('is-enter-start')
  }, [shown])
  return {ref, shown}
}

function placePill(pill: HTMLElement, tab: HTMLElement) {
  pill.style.transform = `translateX(${tab.offsetLeft}px)`
  pill.style.width = `${tab.offsetWidth}px`
}

function snapPill(pill: HTMLElement, tab: HTMLElement) {
  const previous = pill.style.transition
  pill.style.transition = 'none'
  placePill(pill, tab)
  reflow(pill)
  pill.style.transition = previous
}

function movePill(bar: HTMLElement, pill: HTMLElement | null, selector: string, animate: boolean) {
  const tab = bar.querySelector<HTMLElement>(selector)
  if (!pill || !tab) return
  if (animate) placePill(pill, tab)
  else snapPill(pill, tab)
}

export function useTabsPill<T extends HTMLElement>(selector: string) {
  const bar = useRef<T>(null)
  const pill = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const host = bar.current
    if (!host) return
    const move = (animate: boolean) => movePill(host, pill.current, selector, animate)
    move(false)
    const resize = new ResizeObserver(() => move(false))
    const select = new MutationObserver(() => move(true))
    resize.observe(host)
    select.observe(host, {subtree: true, attributeFilter: ['aria-selected', 'aria-pressed']})
    return () => {
      resize.disconnect()
      select.disconnect()
    }
  }, [selector])
  return {bar, pill}
}

export const STATE_MOTION = 'transition-[background-color,border-color] duration-(--duration-quick) ease-(--ease-smooth-out) motion-reduce:transition-none'

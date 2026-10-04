import {useCallback, useRef, useState, useSyncExternalStore} from 'react'

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function prefersReducedMotion() {
  return window.matchMedia(REDUCED_MOTION).matches
}

function onReducedMotionChange(notify: () => void) {
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}

export function useReducedMotion() {
  return useSyncExternalStore(onReducedMotionChange, prefersReducedMotion)
}

export function cssValue(name: string) {
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

function replayPanel(panel: HTMLElement) {
  panel.dataset.open = 'false'
  reflow(panel)
  panel.dataset.open = 'true'
}

export function useReveal(key: string) {
  const last = useRef(key)
  return useCallback(
    (panel: HTMLDivElement | null) => {
      if (!panel || last.current === key) return
      last.current = key
      replayPanel(panel)
    },
    [key],
  )
}

function showOnMount(block: HTMLDivElement | null) {
  if (!block) return
  block.classList.remove('is-hiding', 'is-shown')
  reflow(block)
  block.classList.add('is-shown')
}

export function useShownOnMount() {
  return showOnMount
}

function enter(el: HTMLElement) {
  if (!el.classList.contains('is-exit')) return
  el.classList.remove('is-exit')
  el.classList.add('is-enter-start')
  reflow(el)
  el.classList.remove('is-enter-start')
}

export function useTextSwap(text: string) {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(text)
  const entered = useRef(shown)
  if (reduced && text !== shown) setShown(text)
  const ref = useCallback(
    (el: HTMLSpanElement | null) => {
      if (!el) return
      if (entered.current !== shown) enter(el)
      entered.current = shown
      if (text === shown) return el.classList.remove('is-exit')
      el.classList.add('is-exit')
      const timer = setTimeout(() => setShown(text), cssMs('--text-swap-dur', 150))
      return () => clearTimeout(timer)
    },
    [text, shown],
  )
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
  const pill = useRef<HTMLSpanElement>(null)
  const bar = useCallback(
    (host: T | null) => {
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
    },
    [selector],
  )
  return {bar, pill}
}

export const STATE_MOTION = 'transition-[background-color,border-color] duration-(--duration-quick) ease-(--ease-smooth-out) motion-reduce:transition-none'

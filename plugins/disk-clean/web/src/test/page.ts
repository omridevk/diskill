import {vi} from 'vitest'
import type {ScanEvent} from '@/lib/scan-feed'

export function fakeEventSource() {
  const target = new EventTarget()
  let unheard: Event[] | null = []
  const connect = () => {
    const replay = unheard ?? []
    unheard = null
    for (const event of replay) EventTarget.prototype.dispatchEvent.call(target, event)
  }
  const source = Object.assign(target, {
    readyState: 1,
    close: () => {
      source.readyState = 2
    },
    addEventListener: (...args: Parameters<EventTarget['addEventListener']>) => {
      EventTarget.prototype.addEventListener.apply(target, args)
      queueMicrotask(connect)
    },
    dispatchEvent: (event: Event) => (unheard ? unheard.push(event) > 0 : EventTarget.prototype.dispatchEvent.call(target, event)),
  })
  const send = (event: ScanEvent) => source.dispatchEvent(new MessageEvent(event.type, {data: JSON.stringify(event.data)}))
  return {source, send}
}

export function ringPoints(chart: Element) {
  const sectors = [...chart.querySelectorAll('.storage-base path')].map(p => p.getBoundingClientRect())
  const right = Math.max(...sectors.map(r => r.right))
  const top = Math.min(...sectors.map(r => r.top))
  const bottom = Math.max(...sectors.map(r => r.bottom))
  const radius = (bottom - top) / 2
  const box = chart.getBoundingClientRect()
  return (turn: number, ring: number) => {
    const distance = radius * (0.28 + 0.36 * (ring + 0.5))
    const x = right - radius + distance * Math.sin(turn * 2 * Math.PI)
    const y = (top + bottom) / 2 - distance * Math.cos(turn * 2 * Math.PI)
    return {client: {x, y}, local: {x: x - box.left, y: y - box.top}}
  }
}

export function sendRaw(source: EventTarget, type: string, data: object) {
  source.dispatchEvent(new MessageEvent(type, {data: JSON.stringify(data)}))
}

export function sendAll(source: EventTarget, events: readonly {type: string; data: object}[]) {
  for (const event of events) sendRaw(source, event.type, event.data)
  return new Promise(requestAnimationFrame)
}

const GB = 1024 ** 3

export const PLAN = {
  hold: ['app-a', 'app-b', 'app-c', 'app-d'].map((name, i) => ({
    path: `/Users/you/Library/Caches/${name}`,
    bytes: [2, 1, 0.5, 0.25][i]! * GB,
    held: `/Users/you/.cache/disk-clean/held/run-1/${i + 1}`,
  })),
  hold_bytes: 3.75 * GB,
  hold_until: 1_800_000_000,
  final: ['git -C /Users/you/code worktree remove /Users/you/code/wt', 'git -C /Users/you/code worktree prune', 'docker system prune -f'],
  final_bytes: 6 * GB,
  final_count: 2,
  rejected: [{reason: 'already gone', path: '/Users/you/old'}],
  count: 6,
  bytes: 9.75 * GB,
}

export function mockServer(plan: object = PLAN, failing: ReadonlySet<string> = new Set()) {
  return vi.spyOn(window, 'fetch').mockImplementation(async input => {
    const url = String(input)
    if (failing.has(url)) return new Response('server said no', {status: 500})
    return new Response(url === '/preview' ? JSON.stringify(plan) : '{}', {status: url === '/preview' || url === '/decide' ? 200 : 202})
  })
}

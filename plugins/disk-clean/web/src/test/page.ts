import type {ScanEvent} from '@/lib/scan'

export function fakeEventSource() {
  const source = Object.assign(new EventTarget(), {
    readyState: 1,
    close: () => {
      source.readyState = 2
    },
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
}

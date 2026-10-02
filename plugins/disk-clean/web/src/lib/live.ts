import {useEffect, useReducer} from 'react'
import type {EventSourceLike, Loaded, OpenEvents} from './data'
import {scanReducer, startScan, type ScanEvent} from './scan'

const TYPES: ScanEvent['type'][] = ['disk', 'progress', 'item', 'walked', 'done', 'error']
const FINAL = new Set<ScanEvent['type']>(['done', 'error'])
const CLOSED = 2

const openEventSource: OpenEvents = url => new EventSource(url)

function toEvent(type: ScanEvent['type'], message: Event) {
  if (!(message instanceof MessageEvent) || typeof message.data !== 'string') return null
  return {type, data: JSON.parse(message.data)} as ScanEvent
}

function onMessage(source: EventSourceLike, type: ScanEvent['type'], emit: (event: ScanEvent) => void) {
  return (message: Event) => {
    const event = toEvent(type, message)
    if (!event) return
    emit(event)
    if (FINAL.has(type)) source.close()
  }
}

function onConnectionError(source: EventSourceLike, emit: (event: ScanEvent) => void) {
  return (message: Event) => {
    if (message instanceof MessageEvent || source.readyState !== CLOSED) return
    emit({type: 'error', data: {message: 'Lost the connection to the scan', elapsed_ms: 0}})
  }
}

function listen(source: EventSourceLike, emit: (event: ScanEvent) => void) {
  for (const type of TYPES) source.addEventListener(type, onMessage(source, type, emit))
  source.addEventListener('error', onConnectionError(source, emit))
}

export function useScan(loaded: Loaded) {
  const [scan, dispatch] = useReducer(scanReducer, loaded, startScan)
  useEffect(() => {
    if (!loaded.live) return
    const source = (loaded.openEvents ?? openEventSource)(`/events?token=${encodeURIComponent(loaded.token)}`)
    listen(source, dispatch)
    return () => source.close()
  }, [loaded])
  return scan
}

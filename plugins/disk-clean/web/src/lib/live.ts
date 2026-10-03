import {useEffect, useReducer, useState} from 'react'
import {rescan as requestRescan} from './api'
import type {EventSourceLike, Loaded, OpenEvents} from './data'
import {scanReducer, startScan, type ScanEvent} from './scan'

const TYPES: ScanEvent['type'][] = ['disk', 'progress', 'item', 'walked', 'done', 'error', 'rescan']
const FINAL = new Set<ScanEvent['type']>(['done', 'error'])
const CLOSED = 2

export const openEventSource: OpenEvents = url => new EventSource(url)

export function messageData(message: Event): unknown {
  if (!(message instanceof MessageEvent) || typeof message.data !== 'string') return null
  return JSON.parse(message.data)
}

function toEvent(type: ScanEvent['type'], message: Event) {
  const data = messageData(message)
  return data === null ? null : ({type, data} as ScanEvent)
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
  const [stream, setStream] = useState(loaded.live ? 1 : 0)
  useEffect(() => {
    if (stream === 0) return
    const source = (loaded.openEvents ?? openEventSource)(`/events?token=${encodeURIComponent(loaded.token)}`)
    listen(source, dispatch)
    return () => source.close()
  }, [loaded, stream])
  const rescan = () => {
    dispatch({type: 'rescan', data: {elapsed_ms: 0}})
    requestRescan(loaded.token).then(
      () => setStream(n => n + 1),
      (e: unknown) => dispatch({type: 'error', data: {message: e instanceof Error ? e.message : String(e), elapsed_ms: 0}}),
    )
  }
  return {scan, rescan}
}

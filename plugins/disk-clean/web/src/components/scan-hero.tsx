import {useEffect, useState} from 'react'
import {formatBytes} from '@/lib/data'
import {useReducedMotion} from '@/lib/motion'
import type {Scan} from '@/lib/scan'
import ParticleText from './react-bits/particle-text'

const GATHER_MS = 3000
const DIR_CHARS = 64
const SCANNING = 'Scanning your disk…'

function shorten(dir: string) {
  return dir.length > DIR_CHARS ? `…${dir.slice(-(DIR_CHARS - 1))}` : dir
}

function useHandedOver(scan: Scan, reduced: boolean) {
  const ready = scan.walked || scan.error !== ''
  const delay = scan.error || reduced ? 0 : GATHER_MS
  const [handedOver, setHandedOver] = useState(ready)
  useEffect(() => {
    if (!ready || handedOver) return
    const timer = setTimeout(() => setHandedOver(true), delay)
    return () => clearTimeout(timer)
  }, [ready, handedOver, delay])
  return handedOver
}

function ScanOverlay({text, reduced}: {text: string; reduced: boolean}) {
  if (reduced) return <span className="absolute top-0 left-0 whitespace-nowrap">{text}</span>
  return (
    <div className="pointer-events-none absolute top-0 left-0 h-full">
      <span aria-hidden className="invisible block whitespace-nowrap">
        {text}
      </span>
      <div className="absolute -inset-x-10 -inset-y-3">
        <ParticleText
          text={text}
          color="#fafafa"
          highlightColor="#60a5fa"
          fontSize={48}
          fontWeight={700}
          particleSize={1.6}
          density={2}
          scatter={60}
          repelRadius={60}
          style={{minHeight: 0}}
        />
      </div>
    </div>
  )
}

export function useScanHero(live: boolean, scan: Scan, selected: number) {
  const reduced = useReducedMotion()
  const handedOver = useHandedOver(scan, reduced)
  const [gathered, setGathered] = useState<number | null>(null)
  if (scan.walked && gathered === null) setGathered(selected)
  const showing = live && !handedOver
  const text = gathered === null ? SCANNING : formatBytes(gathered)
  return {
    bytes: showing ? (gathered ?? selected) : selected,
    overlay: showing ? <ScanOverlay text={text} reduced={reduced} /> : null,
  }
}

export function ScanCounter({scan}: {scan: Scan}) {
  const {files, bytes, dir} = scan.progress
  return (
    <div className="flex h-5 min-w-0 items-baseline gap-3 text-[13px] text-muted-foreground tabular-nums">
      <span className="shrink-0">
        {files.toLocaleString()} files · {formatBytes(bytes)}
        {scan.walked ? ' scanned' : ''}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground/70" title={dir}>
        {scan.walked ? '' : shorten(dir)}
      </span>
    </div>
  )
}

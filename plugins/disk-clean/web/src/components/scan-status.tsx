import {useEffect, useState} from 'react'
import type {Scan} from '@/lib/scan'
import LatticeLoader from './react-bits/lattice-loader'

const TICK_MS = 100

function statusOf(scan: Scan) {
  if (scan.error) return 'error'
  return scan.done ? 'done' : 'working'
}

function phaseOf(scan: Scan) {
  if (!scan.walked) return 'Walking disk'
  return `Checking ${scan.worktrees} ${scan.worktrees === 1 ? 'worktree' : 'worktrees'}`
}

function useScanClock(elapsed: number, running: boolean) {
  const [last, setLast] = useState({elapsed, at: performance.now()})
  const [now, setNow] = useState(last.at)
  if (last.elapsed !== elapsed) setLast({elapsed, at: performance.now()})
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(performance.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [running])
  return running ? elapsed + Math.max(0, now - last.at) : elapsed
}

export function ScanStatus({scan}: {scan: Scan}) {
  const status = statusOf(scan)
  const clock = useScanClock(scan.elapsed, status === 'working')
  const phase = phaseOf(scan)
  return (
    <LatticeLoader
      key={phase}
      label={phase}
      doneLabel="Scan complete"
      errorLabel="Scan failed"
      status={status}
      elapsed={(clock - (scan.walked ? scan.walkedAt : 0)) / 1000}
      fontSize={13}
      cellSize={4}
      className="text-muted-foreground"
    />
  )
}

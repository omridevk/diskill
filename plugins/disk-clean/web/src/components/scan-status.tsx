import {RotateCw} from 'lucide-react'
import {useState} from 'react'
import {Button} from '@/components/ui/button'
import {useClock} from '@/lib/clock'
import type {Scan} from '@/lib/scan'
import LatticeLoader from './react-bits/lattice-loader'

function statusOf(scan: Scan) {
  if (scan.error) return 'error'
  return scan.done ? 'done' : 'working'
}

function phaseOf(scan: Scan) {
  if (!scan.walked) return scan.rescans > 0 ? 'Rescanning' : 'Walking disk'
  return `Checking ${scan.worktrees} ${scan.worktrees === 1 ? 'worktree' : 'worktrees'}`
}

function useScanClock(elapsed: number, running: boolean) {
  const [last, setLast] = useState({elapsed, at: performance.now()})
  const now = useClock(running)
  if (last.elapsed !== elapsed) setLast({elapsed, at: performance.now()})
  return running ? elapsed + Math.max(0, now - last.at) : elapsed
}

export function ScanStatus({scan}: {scan: Scan}) {
  const status = statusOf(scan)
  const clock = useScanClock(scan.elapsed, status === 'working')
  const phase = phaseOf(scan)
  const phaseStart = scan.walked && status === 'working' ? scan.walkedAt : 0
  return (
    <LatticeLoader
      key={phase}
      label={phase}
      doneLabel="Scan complete"
      errorLabel="Scan failed"
      status={status}
      elapsed={(clock - phaseStart) / 1000}
      fontSize={13}
      cellSize={4}
      className="text-muted-foreground"
    />
  )
}

export function RescanButton({scan, approved, onRescan}: {scan: Scan; approved: boolean; onRescan: () => void}) {
  if (approved) return null
  return (
    <Button variant="ghost" size="xs" disabled={!scan.done && scan.error === ''} onClick={onRescan}>
      <RotateCw />
      Rescan
    </Button>
  )
}

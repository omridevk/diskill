import type {Scan} from '@/lib/scan'
import LatticeLoader from './react-bits/lattice-loader'

function statusOf(scan: Scan) {
  if (scan.error) return 'error'
  return scan.done ? 'done' : 'working'
}

export function ScanStatus({scan}: {scan: Scan}) {
  const phase = scan.walked ? 'Checking worktrees and tools' : 'Walking disk'
  return (
    <LatticeLoader
      key={phase}
      label={phase}
      doneLabel="Scan complete"
      errorLabel="Scan failed"
      status={statusOf(scan)}
      fontSize={13}
      cellSize={4}
      className="text-muted-foreground"
    />
  )
}

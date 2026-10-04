import {Trash2, X} from 'lucide-react'
import {useState, type AnimationEvent, type ReactNode} from 'react'
import {Button} from '@/components/ui/button'
import type {CleanupProgress} from '@/lib/progress'
import {formatBytes, plural} from '@/lib/data'
import {cssMs, useReducedMotion} from '@/lib/motion'
import type {Selection} from '@/lib/page-data'
import {ProgressFooter} from './cleanup-progress'
import {PopBytes} from './numbers'
import FuseButton from './react-bits/fuse-button'

function UndoCountdown({ms}: {ms: number}) {
  const steps = Math.ceil(ms / 1000)
  const [left, setLeft] = useState(steps)
  const tick = (event: AnimationEvent<HTMLSpanElement>) => setLeft(Math.max(0, steps - Math.round(event.elapsedTime)))
  return (
    <span
      className="t-clock"
      style={{animationDuration: '1000ms', animationIterationCount: steps, animationDelay: `${ms - steps * 1000}ms`}}
      onAnimationIteration={tick}
      onAnimationEnd={() => setLeft(0)}
    >
      Undo ({left}s)
    </span>
  )
}

function undoLabel(reduced: boolean, armed: boolean, ms: number) {
  if (!reduced) return 'Undo'
  return armed ? <UndoCountdown ms={ms} /> : `Undo (${Math.ceil(ms / 1000)}s)`
}

interface FuseAction {
  label: string
  doneLabel: string
  icon: ReactNode
  background: string
  color: string
  onCommit: () => void
}

function FuseAction({label, doneLabel, icon, background, color, onCommit}: FuseAction) {
  const reduced = useReducedMotion()
  const undoWindow = cssMs('--fuse-window', 4000)
  const [armed, setArmed] = useState(false)
  return (
    <FuseButton
      label={label}
      undoLabel={undoLabel(reduced, armed, undoWindow)}
      doneLabel={doneLabel}
      icon={icon}
      size="sm"
      radius={8}
      className="shrink-0"
      background={background}
      color={color}
      fuseColor={reduced ? 'transparent' : '#ef4444'}
      fuseThickness={2}
      undoWindow={undoWindow}
      commitOn="fuseEnd"
      onCommit={onCommit}
      onPhaseChange={phase => setArmed(phase === 'armed')}
    />
  )
}

function hint(locked: boolean) {
  return locked ? ' · Delete unlocks when the scan finishes' : ' · Cancel gives you a few seconds to undo'
}

export function ActionBar({
  selection,
  locked,
  progress = null,
  held,
  failure,
  onCancel,
  onDelete,
}: {
  selection: Selection
  locked: boolean
  progress?: CleanupProgress | null
  held?: ReactNode
  failure?: ReactNode
  onCancel: () => void
  onDelete: () => void
}) {
  if (progress) return <ProgressFooter progress={progress} held={held} />
  const count = selection.selected.length
  const disabled = count === 0 || locked

  return (
    <footer className="flex items-center gap-2.5 border-t bg-card px-7 py-3.5">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <div className="text-sm font-semibold tabular-nums">
          {plural(count, 'item', 'items')} selected · <PopBytes bytes={selection.exactBytes} />
          {selection.apparentBytes > 0 && (
            <span className="font-normal text-muted-foreground"> (+≈{formatBytes(selection.apparentBytes)} apparent)</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          Delete moves files to a holding folder first, so you can undo or free the space afterwards · worktrees and commands can't be undone
          {hint(locked)}
        </div>
        {failure}
      </div>
      <FuseAction label="Cancel" doneLabel="Cancelling" icon={<X />} background="transparent" color="var(--foreground)" onCommit={onCancel} />
      <Button size="lg" className="shrink-0" disabled={disabled} aria-haspopup="dialog" onClick={onDelete}>
        <Trash2 /> Delete {plural(count, 'item', 'items')} · {formatBytes(selection.exactBytes)}
      </Button>
    </footer>
  )
}

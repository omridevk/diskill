import {Eraser, RotateCcw, Trash2, X} from 'lucide-react'
import {useState, type AnimationEvent, type ReactNode} from 'react'
import {Button} from '@/components/ui/button'
import type {CleanupProgress} from '@/lib/progress'
import {formatBytes, plural, sizeOf} from '@/lib/data'
import {cssMs, useReducedMotion} from '@/lib/motion'
import type {Selection} from '@/lib/page-data'
import type {ScanState} from '@/lib/scan-feed'
import {ProgressFooter} from './cleanup-progress'
import {PopBytes} from './numbers'
import FuseButton from './react-bits/fuse-button'
import {useSelectionWarnings, WarningChip} from './selection-warnings'

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

function hint(scan: ScanState) {
  return !scan.done && scan.error === '' ? ' · you can delete what is listed while the scan runs' : ' · Cancel gives you a few seconds to undo'
}

function deleteState(selection: Selection, scan: ScanState) {
  const count = selection.selected.length
  if (scan.error !== '') return {label: 'The scan failed · nothing can be deleted', ready: false}
  if (count > 0) return {label: `Delete ${plural(count, 'item', 'items')} · ${sizeOf(selection.exactBytes, selection.apparentBytes)}`, ready: true}
  if (selection.selectable > 0) return {label: 'Select items to delete', ready: false}
  if (!scan.done) return {label: 'Scanning… nothing found yet', ready: false}
  return {label: 'Nothing found to delete', ready: false}
}

const HELP = "Delete moves files to a holding folder first, so you can undo or free the space afterwards · worktrees and commands can't be undone"

function SelectionButton({label, icon, reason, onClick}: {label: string; icon: ReactNode; reason: string; onClick: () => void}) {
  const described = reason ? `${label}: ${reason}` : label
  return (
    <Button variant="ghost" size="icon-xs" disabled={reason !== ''} aria-label={described} title={described} onClick={onClick}>
      {icon}
    </Button>
  )
}

export function ActionBar({
  selection,
  scan,
  progress = null,
  held,
  failure,
  onCancel,
  onDelete,
}: {
  selection: Selection
  scan: ScanState
  progress?: CleanupProgress | null
  held?: ReactNode
  failure?: ReactNode
  onCancel: () => void
  onDelete: () => void
}) {
  const warnings = useSelectionWarnings(selection)
  if (progress) return <ProgressFooter progress={progress} held={held} />
  const count = selection.selected.length
  const action = deleteState(selection, scan)

  return (
    <footer className="flex items-center gap-2.5 border-t bg-card px-7 py-3.5">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <div className="flex h-6 items-center gap-1">
          <div className="w-64 shrink-0 truncate text-sm font-semibold tabular-nums">
            {plural(count, 'item', 'items')} selected · {selection.exactBytes === 0 && selection.apparentBytes > 0 ? `≈${formatBytes(selection.apparentBytes)}` : <PopBytes bytes={selection.exactBytes} />}
          </div>
          <SelectionButton label="Clear selection" icon={<Eraser />} reason={count === 0 ? 'nothing is selected' : ''} onClick={selection.clear} />
          <SelectionButton label="Reset to recommended" icon={<RotateCcw />} reason={selection.recommended ? 'already the recommended selection' : ''} onClick={selection.reset} />
          <div className="flex min-w-0 grow pl-2">
            <WarningChip warnings={warnings} />
          </div>
        </div>
        <div className="truncate text-xs text-muted-foreground" title={HELP + hint(scan)}>
          {HELP}
          {hint(scan)}
        </div>
        {failure}
      </div>
      <FuseAction label="Cancel" doneLabel="Cancelling" icon={<X />} background="transparent" color="var(--foreground)" onCommit={onCancel} />
      <Button size="lg" className="w-80 shrink-0 justify-start" disabled={!action.ready} aria-haspopup="dialog" onClick={onDelete}>
        <Trash2 /> {action.label}
      </Button>
    </footer>
  )
}

import {Loader2, SquareTerminal, Trash2} from 'lucide-react'
import {useEffect, useState} from 'react'
import {Button} from '@/components/ui/button'
import {formatBytes} from '@/lib/data'
import {cssMs, useReducedMotion, useTextSwap} from '@/lib/motion'
import type {Selection} from '@/lib/selection'
import {PopBytes} from './numbers'
import FuseButton from './react-bits/fuse-button'

const CHECKING = 'Checking…'

function PreviewLabel({text}: {text: string}) {
  if (text !== CHECKING) return text
  return (
    <>
      <span aria-hidden className="t-shimmer" data-text={text}>
        {text}
      </span>
      <span className="sr-only">{text}</span>
    </>
  )
}

function PreviewButton({disabled, previewing, onClick}: {disabled: boolean; previewing: boolean; onClick: () => void}) {
  const label = useTextSwap(previewing ? CHECKING : 'Preview commands')
  return (
    <Button variant="outline" size="lg" disabled={disabled || previewing} onClick={onClick}>
      <span className="t-icon-swap" data-state={previewing ? 'b' : 'a'}>
        <SquareTerminal className="t-icon" data-icon="a" />
        <span className="t-icon" data-icon="b">
          <Loader2 className={previewing ? 'animate-spin motion-reduce:animate-none' : undefined} />
        </span>
      </span>
      <span ref={label.ref} className="t-text-swap">
        <PreviewLabel text={label.shown} />
      </span>
    </Button>
  )
}

function useCountdown(running: boolean, ms: number) {
  const [left, setLeft] = useState(ms)
  useEffect(() => {
    setLeft(ms)
    if (!running) return
    const started = performance.now()
    const timer = setInterval(() => setLeft(Math.max(0, ms - (performance.now() - started))), 250)
    return () => clearInterval(timer)
  }, [running, ms])
  return Math.ceil(left / 1000)
}

function ApproveButton({disabled, onApprove}: {disabled: boolean; onApprove: () => void}) {
  const reduced = useReducedMotion()
  const undoWindow = cssMs('--fuse-window', 4000)
  const [armed, setArmed] = useState(false)
  const seconds = useCountdown(armed && reduced, undoWindow)
  return (
    <FuseButton
      label="Approve and delete"
      undoLabel={reduced ? `Undo (${seconds}s)` : 'Undo'}
      doneLabel="Approving"
      icon={<Trash2 />}
      size="sm"
      radius={8}
      background="var(--primary)"
      color="var(--primary-foreground)"
      fuseColor={reduced ? 'transparent' : '#ef4444'}
      fuseThickness={2}
      undoWindow={undoWindow}
      commitOn="fuseEnd"
      disabled={disabled}
      onCommit={onApprove}
      onPhaseChange={phase => setArmed(phase === 'armed')}
    />
  )
}

function hint(locked: boolean) {
  return locked ? ' · Preview and Approve unlock when the scan finishes' : ' · Approve gives you a few seconds to undo'
}

export function ActionBar({
  selection,
  locked,
  previewing,
  onCancel,
  onPreview,
  onApprove,
}: {
  selection: Selection
  locked: boolean
  previewing: boolean
  onCancel: () => void
  onPreview: () => void
  onApprove: () => void
}) {
  const count = selection.selected.length
  const disabled = count === 0 || locked

  return (
    <footer data-review="actions" className="flex items-center gap-2.5 border-t bg-card px-7 py-3.5">
      <div className="flex grow flex-col gap-0.5">
        <div className="text-sm font-semibold tabular-nums">
          {count} {count === 1 ? 'item' : 'items'} selected · <PopBytes bytes={selection.exactBytes} />
          {selection.apparentBytes > 0 && (
            <span className="font-normal text-muted-foreground"> (+≈{formatBytes(selection.apparentBytes)} apparent)</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          Permanent delete, not to the Trash · worktrees are re-checked right before removal
          {hint(locked)}
        </div>
      </div>
      <Button variant="ghost" size="lg" onClick={onCancel}>
        Cancel
      </Button>
      <PreviewButton disabled={disabled} previewing={previewing} onClick={onPreview} />
      <ApproveButton disabled={disabled} onApprove={onApprove} />
    </footer>
  )
}

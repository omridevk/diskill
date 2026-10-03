import {Loader2, SquareTerminal, Trash2, X} from 'lucide-react'
import {useEffect, useState, type ReactNode, type RefObject} from 'react'
import {Button} from '@/components/ui/button'
import type {CleanupProgress} from '@/lib/cleanup'
import {formatBytes} from '@/lib/data'
import {cssMs, useReducedMotion, useTextSwap} from '@/lib/motion'
import type {Selection} from '@/lib/selection'
import {ProgressFooter} from './cleanup-progress'
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

function PreviewButton({disabled, previewing, onClick, buttonRef}: {disabled: boolean; previewing: boolean; onClick: () => void; buttonRef?: RefObject<HTMLButtonElement | null>}) {
  const label = useTextSwap(previewing ? CHECKING : 'Preview commands')
  return (
    <Button ref={buttonRef} variant="outline" size="lg" className="shrink-0" disabled={disabled} aria-busy={previewing} onClick={previewing ? undefined : onClick}>
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

interface FuseAction {
  label: string
  doneLabel: string
  icon: ReactNode
  background: string
  color: string
  disabled?: boolean
  onCommit: () => void
}

function FuseAction({label, doneLabel, icon, background, color, disabled = false, onCommit}: FuseAction) {
  const reduced = useReducedMotion()
  const undoWindow = cssMs('--fuse-window', 4000)
  const [armed, setArmed] = useState(false)
  const seconds = useCountdown(armed && reduced, undoWindow)
  return (
    <FuseButton
      label={label}
      undoLabel={reduced ? `Undo (${seconds}s)` : 'Undo'}
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
      disabled={disabled}
      onCommit={onCommit}
      onPhaseChange={phase => setArmed(phase === 'armed')}
    />
  )
}

function hint(locked: boolean) {
  return locked ? ' · Preview and Approve unlock when the scan finishes' : ' · Approve and Cancel give you a few seconds to undo'
}

export function ActionBar({
  selection,
  locked,
  progress = null,
  previewing,
  previewRef,
  onCancel,
  onPreview,
  onApprove,
}: {
  selection: Selection
  locked: boolean
  progress?: CleanupProgress | null
  previewing: boolean
  previewRef?: RefObject<HTMLButtonElement | null>
  onCancel: () => void
  onPreview: () => void
  onApprove: () => void
}) {
  if (progress) return <ProgressFooter progress={progress} />
  const count = selection.selected.length
  const disabled = count === 0 || locked

  return (
    <footer className="flex items-center gap-2.5 border-t bg-card px-7 py-3.5">
      <div className="flex min-w-0 grow flex-col gap-0.5">
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
      <FuseAction label="Cancel" doneLabel="Cancelling" icon={<X />} background="transparent" color="var(--foreground)" onCommit={onCancel} />
      <PreviewButton disabled={disabled} previewing={previewing} onClick={onPreview} buttonRef={previewRef} />
      <FuseAction
        key={String(disabled)}
        label="Approve and delete"
        doneLabel="Approving"
        icon={<Trash2 />}
        background="var(--primary)"
        color="var(--primary-foreground)"
        disabled={disabled}
        onCommit={onApprove}
      />
    </footer>
  )
}

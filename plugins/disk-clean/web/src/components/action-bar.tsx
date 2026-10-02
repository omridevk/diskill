import {Loader2, SquareTerminal} from 'lucide-react'
import {useEffect, useState} from 'react'
import {Button} from '@/components/ui/button'
import {formatBytes} from '@/lib/data'
import {useTextSwap} from '@/lib/motion'
import type {Selection} from '@/lib/selection'
import {PopBytes} from './numbers'

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
    <Button variant="outline" disabled={disabled || previewing} onClick={onClick}>
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

function ApproveButton({disabled, armed, onClick}: {disabled: boolean; armed: boolean; onClick: () => void}) {
  const label = useTextSwap(armed ? 'Click again to confirm' : 'Approve and delete')
  return (
    <Button disabled={disabled} onClick={onClick} className={armed ? 'bg-red-600 text-white hover:bg-red-600/90' : undefined}>
      <span ref={label.ref} className="t-text-swap">
        {label.shown}
      </span>
    </Button>
  )
}

export function ActionBar({selection, previewing, onCancel, onPreview, onApprove}: {selection: Selection; previewing: boolean; onCancel: () => void; onPreview: () => void; onApprove: () => void}) {
  const [armed, setArmed] = useState(false)
  const count = selection.selected.length
  const needsConfirm = selection.risky.length > 0

  useEffect(() => setArmed(false), [selection.selected])

  const approve = () => {
    if (needsConfirm && !armed) {
      setArmed(true)
      return
    }
    onApprove()
  }

  return (
    <footer className="flex items-center gap-2.5 border-t bg-card px-7 py-3.5">
      <div className="flex grow flex-col gap-0.5">
        <div className="text-sm font-semibold tabular-nums">
          {count} {count === 1 ? 'item' : 'items'} selected · <PopBytes bytes={selection.exactBytes} />
          {selection.apparentBytes > 0 && (
            <span className="font-normal text-muted-foreground"> (+≈{formatBytes(selection.apparentBytes)} apparent)</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          Permanent delete, not to the Trash · worktrees are re-checked right before removal
          {needsConfirm ? ' · review items need a second click' : ''}
        </div>
      </div>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <PreviewButton disabled={count === 0} previewing={previewing} onClick={onPreview} />
      <ApproveButton disabled={count === 0} armed={armed} onClick={approve} />
    </footer>
  )
}

import {Loader2, SquareTerminal} from 'lucide-react'
import {useEffect, useState} from 'react'
import {Button} from '@/components/ui/button'
import {formatBytes} from '@/lib/data'
import type {Selection} from '@/lib/selection'

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
          {count} {count === 1 ? 'item' : 'items'} selected · {formatBytes(selection.exactBytes)}
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
      <Button variant="outline" disabled={count === 0 || previewing} onClick={onPreview}>
        {previewing ? <Loader2 className="animate-spin" /> : <SquareTerminal />}
        Preview commands
      </Button>
      <Button
        disabled={count === 0}
        onClick={approve}
        className={armed ? 'bg-red-600 text-white hover:bg-red-600/90' : undefined}
      >
        {armed ? 'Click again to confirm' : 'Approve and delete'}
      </Button>
    </footer>
  )
}

import type {RefObject} from 'react'
import {Button} from '@/components/ui/button'
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {formatUntil, type CleanupProgress} from '@/lib/cleanup'
import {formatBytes} from '@/lib/data'

export function FreeDialog({
  progress,
  open,
  onOpenChange,
  onClosed,
  onFree,
  returnFocus,
}: {
  progress: CleanupProgress
  open: boolean
  onOpenChange: (open: boolean) => void
  onClosed: () => void
  onFree: () => void
  returnFocus?: RefObject<HTMLButtonElement | null>
}) {
  const count = progress.heldCount
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={next => next || onClosed()}>
      <DialogContent className="sm:max-w-md" finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>Free the space now?</DialogTitle>
          <DialogDescription>
            This deletes the {count} held {count === 1 ? 'item' : 'items'} ({formatBytes(progress.held)}) for good. It can't be undone: Undo
            stops working for them. Left alone they stay held until {formatUntil(progress.holdUntil)}, then the next disk-clean run frees them.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep them held
          </Button>
          <Button variant="destructive" onClick={onFree}>
            Free {formatBytes(progress.held)} for good
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

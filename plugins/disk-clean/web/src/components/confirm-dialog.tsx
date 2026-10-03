import {useVirtualizer} from '@tanstack/react-virtual'
import {Loader2} from 'lucide-react'
import {useRef, type ReactNode, type RefObject} from 'react'
import {Button} from '@/components/ui/button'
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import type {Plan} from '@/lib/api'
import {formatUntil} from '@/lib/cleanup'
import {formatBytes} from '@/lib/data'

const ROW = 28

function Group({title, note, tone, children}: {title: string; note: string; tone: string; children: ReactNode}) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className={`text-sm font-semibold ${tone}`}>
        {title} <span className="font-normal text-muted-foreground">· {note}</span>
      </h3>
      {children}
    </section>
  )
}

function HeldPaths({rows}: {rows: Plan['hold']}) {
  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 12})
  return (
    <div ref={scroller} className="max-h-[30vh] overflow-y-auto rounded-lg border bg-background">
      <ul aria-label="Moved to hold" className="relative" style={{height: virtualizer.getTotalSize()}}>
        {virtualizer.getVirtualItems().map(virtual => {
          const row = rows[virtual.index]
          return (
            row && (
              <li
                key={row.path}
                aria-setsize={rows.length}
                aria-posinset={virtual.index + 1}
                className="absolute top-0 left-0 flex w-full items-center gap-3 px-3 font-mono text-xs"
                style={{height: ROW, transform: `translateY(${virtual.start}px)`}}
              >
                <span className="min-w-0 grow truncate">{row.path}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(row.bytes)}</span>
              </li>
            )
          )
        })}
      </ul>
    </div>
  )
}

function Lines({label, lines}: {label: string; lines: string[]}) {
  return (
    <ul aria-label={label} className="max-h-[22vh] overflow-y-auto rounded-lg border bg-background px-3 py-2 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => (
        <li key={i} className="break-all">
          {line}
        </li>
      ))}
    </ul>
  )
}

function confirmLabel(plan: Plan) {
  const held = plan.hold.length
  if (held === 0) return `Delete ${plan.count} ${plan.count === 1 ? 'item' : 'items'}`
  const rest = plan.final_count > 0 ? ` + ${plan.final_count} that can't be undone` : ''
  return `Move ${held} ${held === 1 ? 'item' : 'items'} to hold${rest}`
}

function Totals({plan}: {plan: Plan}) {
  const figures = [
    {n: formatBytes(plan.bytes), label: `${plan.count} items in total`},
    {n: formatBytes(plan.hold_bytes), label: `${plan.hold.length} moved to hold`},
    {n: String(plan.final_count), label: "can't be undone"},
    {n: String(plan.rejected.length), label: 'rejected'},
  ]
  return (
    <div className="grid grid-cols-4 gap-2">
      {figures.map(f => (
        <div key={f.label} className="flex flex-col rounded-lg border px-3 py-2">
          <span className="text-lg font-semibold tabular-nums">{f.n}</span>
          <span className="text-xs text-muted-foreground">{f.label}</span>
        </div>
      ))}
    </div>
  )
}

function Body({plan}: {plan: Plan}) {
  return (
    <>
      <Totals plan={plan} />
      {plan.hold.length > 0 && (
        <Group title="Moved to hold (undo available)" note={`until ${formatUntil(plan.hold_until)}, space comes back when you free them`} tone="text-foreground">
          <HeldPaths rows={plan.hold} />
        </Group>
      )}
      {plan.final.length > 0 && (
        <Group title="Can't be undone" note="worktree removals, held runs and fixed commands run exactly as below" tone="text-amber-300">
          <Lines label="Can't be undone" lines={plan.final} />
        </Group>
      )}
      {plan.rejected.length > 0 && (
        <Group title="Rejected by the safety checks" note="these stay where they are" tone="text-red-300">
          <Lines label="Rejected by the safety checks" lines={plan.rejected.map(r => `${r.path}: ${r.reason}`)} />
        </Group>
      )}
    </>
  )
}

export function ConfirmDialog({
  plan,
  open,
  onOpenChange,
  onConfirm,
  returnFocus,
}: {
  plan: Plan | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  returnFocus?: RefObject<HTMLButtonElement | null>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>Confirm the cleanup</DialogTitle>
          <DialogDescription>
            Nothing has run yet. Each path is resolved again right before it moves and is kept if a parent folder now points
            elsewhere; a symlink is moved itself, never followed. Worktrees are re-checked and git refuses any that changed.
          </DialogDescription>
        </DialogHeader>
        {plan ? (
          <Body plan={plan} />
        ) : (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> Checking the selection…
          </p>
        )}
        <DialogFooter className="items-center">
          <span className="grow text-xs text-muted-foreground">
            Same list in the terminal: <code className="font-mono text-zinc-300">disk-clean clean --dry-run</code>
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="bg-red-600 text-white hover:bg-red-600/90" disabled={!plan || plan.count === 0} onClick={onConfirm}>
            {plan ? confirmLabel(plan) : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

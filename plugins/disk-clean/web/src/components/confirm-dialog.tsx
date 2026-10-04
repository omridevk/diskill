import {useVirtualizer} from '@tanstack/react-virtual'
import {Loader2} from 'lucide-react'
import {Fragment, useRef, type ReactNode} from 'react'
import {Button} from '@/components/ui/button'
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import type {Plan} from '@/lib/api'
import {formatUntil} from '@/lib/cleanup'
import {formatBytes, tilde, tildeWords} from '@/lib/data'

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

function TailPath({path}: {path: string}) {
  return (
    <span className="min-w-0 grow truncate text-left [direction:rtl]">
      <bdi dir="ltr">{path}</bdi>
    </span>
  )
}

function HeldPaths({rows, home}: {rows: Plan['hold']; home: string}) {
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
                <TailPath path={tilde(row.path, home)} />
                <span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(row.bytes)}</span>
              </li>
            )
          )
        })}
      </ul>
    </div>
  )
}

function Word({word}: {word: string}) {
  const parts = word.split('/')
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      <span className="whitespace-nowrap">{i < parts.length - 1 ? `${part}/` : part}</span>
    </Fragment>
  ))
}

function Breakable({text}: {text: string}) {
  return text.split(' ').map((word, i) => (
    <Fragment key={i}>
      {i > 0 && ' '}
      <Word word={word} />
    </Fragment>
  ))
}

function Lines({label, lines}: {label: string; lines: string[]}) {
  return (
    <ul aria-label={label} className="max-h-[22vh] divide-y overflow-y-auto rounded-lg border bg-background font-mono text-xs leading-relaxed">
      {lines.map((line, i) => (
        <li key={i} className="overflow-x-auto py-1.5 pr-3 pl-7 -indent-4">
          <Breakable text={line} />
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

function Body({plan, home}: {plan: Plan; home: string}) {
  return (
    <>
      <Totals plan={plan} />
      {plan.hold.length > 0 && (
        <Group title="Moved to hold (undo available)" note={`until ${formatUntil(plan.hold_until)}, space comes back when you free them`} tone="text-foreground">
          <HeldPaths rows={plan.hold} home={home} />
        </Group>
      )}
      {plan.final.length > 0 && (
        <Group title="Can't be undone" note="worktree removals, held runs and fixed commands run exactly as below" tone="text-amber-300">
          <Lines label="Can't be undone" lines={plan.final.map(line => tildeWords(line, home))} />
        </Group>
      )}
      {plan.rejected.length > 0 && (
        <Group title="Rejected by the safety checks" note="these stay where they are" tone="text-destructive">
          <Lines label="Rejected by the safety checks" lines={plan.rejected.map(r => `${tilde(r.path, home)}: ${r.reason}`)} />
        </Group>
      )}
    </>
  )
}

function Checking() {
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> Checking the selection…
    </p>
  )
}

function Decision({plan, home, onCancel, onConfirm}: {plan: Plan | null; home: string; onCancel: () => void; onConfirm: () => void}) {
  return (
    <>
      {plan ? <Body plan={plan} home={home} /> : <Checking />}
      <DialogFooter className="items-center">
        <span className="grow text-xs text-muted-foreground">
          Same list in the terminal: <code className="font-mono text-zinc-300">disk-clean clean --dry-run</code>
        </span>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={!plan || plan.count === 0} onClick={onConfirm}>
          {plan ? confirmLabel(plan) : 'Delete'}
        </Button>
      </DialogFooter>
    </>
  )
}

interface Exit {
  open: boolean
  onClose: () => void
  onClosed: () => void
}

export function ConfirmDialog({plan, home, open, onClose, onClosed, onConfirm}: Exit & {plan: Plan | null; home: string; onConfirm: () => void}) {
  return (
    <Dialog open={open} onOpenChange={next => next || onClose()} onOpenChangeComplete={next => next || onClosed()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Confirm the cleanup</DialogTitle>
          <DialogDescription>
            Nothing has run yet. Each path is resolved again right before it moves and is kept if a parent folder now points
            elsewhere; a symlink is moved itself, never followed. Worktrees are re-checked and git refuses any that changed.
          </DialogDescription>
        </DialogHeader>
        <Decision plan={plan} home={home} onCancel={onClose} onConfirm={onConfirm} />
      </DialogContent>
    </Dialog>
  )
}

export function ConfirmFailed({message, open, onClose, onClosed, onRetry}: Exit & {message: string; onRetry: () => void}) {
  return (
    <Dialog open={open} onOpenChange={next => next || onClose()} onOpenChangeComplete={next => next || onClosed()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Couldn't check the selection</DialogTitle>
          <DialogDescription>Nothing was deleted. {message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onRetry}>Retry</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

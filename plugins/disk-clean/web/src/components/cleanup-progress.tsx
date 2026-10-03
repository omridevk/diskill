import {Activity, Clapperboard} from 'lucide-react'
import {useVirtualizer} from '@tanstack/react-virtual'
import {memo, useCallback, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject} from 'react'
import {Button} from '@/components/ui/button'
import {Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle} from '@/components/ui/sheet'
import {ToggleGroup, ToggleGroupItem} from '@/components/ui/toggle-group'
import {formatDuration, type Outcome, type CleanupProgress} from '@/lib/cleanup'
import {formatBytes} from '@/lib/data'
import type {LogFilter} from '@/lib/list-view'
import {useReducedMotion} from '@/lib/motion'
import {CleanupFilm} from './cleanup-film'
import {SpinningBytes} from './numbers'

const LOG_ROW_HEIGHT = 52
const LOG_OVERSCAN = 10
const WAITING = 'Approved · Claude is showing the commands in your terminal'

const FILTERS: Record<LogFilter, (o: Outcome) => boolean> = {
  all: () => true,
  removed: o => o.kind === 'removed',
  problems: o => o.kind === 'failed' || o.kind === 'kept',
  commands: o => o.key.startsWith('cmd:'),
}

const FILTER_LABEL: Record<LogFilter, string> = {all: 'All', removed: 'Removed', problems: 'Problems', commands: 'Commands'}

function share(progress: CleanupProgress) {
  if (progress.cleanup.done) return 1
  const {freed, count, total, plan} = progress
  const bytes = plan.approved > 0 ? freed / plan.approved : 0
  return Math.min(1, Math.max(bytes, total > 0 ? count / total : 0))
}

function counted(n: number, label: string, tone: string) {
  return (
    <span className={n > 0 ? tone : undefined}>
      {' · '}
      {n} {label}
    </span>
  )
}

function DoneText({progress}: {progress: CleanupProgress}) {
  const all = progress.outcomes
  const removed = all.filter(o => o.kind === 'removed').length
  return (
    <>
      Freed {formatBytes(progress.freed)} · {removed} removed
      {counted(all.filter(o => o.kind === 'kept').length, 'kept', 'text-amber-300')}
      {counted(all.filter(o => o.kind === 'failed').length, 'not removed', 'text-red-300')}
    </>
  )
}

export function BarText({progress, lost}: {progress: CleanupProgress; lost: boolean}) {
  const {cleanup, plan} = progress
  if (cleanup.done) return <DoneText progress={progress} />
  if (!cleanup.started) return <span className="t-pulse">{WAITING}</span>
  if (lost) return 'Reconnecting…'
  const last = progress.outcomes.at(-1)
  return (
    <>
      Deleting · {formatBytes(progress.freed)} of {formatBytes(plan.approved)} · {progress.count} of {progress.total}
      {last && <span className="text-muted-foreground"> · {last.label}</span>}
    </>
  )
}

export function ProgressTrack({progress}: {progress: CleanupProgress}) {
  const waiting = !progress.cleanup.started && !progress.cleanup.done
  return (
    <span aria-hidden className="absolute inset-x-0 -bottom-px h-[3px] overflow-hidden bg-zinc-800">
      <span
        className={`block size-full origin-left bg-blue-500 transition-transform duration-(--duration-very-slow) ease-(--ease-smooth-out) motion-reduce:transition-none ${waiting ? 't-pulse' : ''}`}
        style={{transform: `scaleX(${waiting ? 1 : share(progress)})`}}
      />
    </span>
  )
}

export function DetailsButton({onClick, ref}: {onClick: () => void; ref?: Ref<HTMLButtonElement>}) {
  return (
    <Button ref={ref} variant="outline" aria-haspopup="dialog" onClick={onClick}>
      <Activity /> Details
    </Button>
  )
}

function Stat({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-sm font-semibold tabular-nums">{children}</span>
    </div>
  )
}

function elapsedOf(progress: CleanupProgress) {
  const timed = progress.cleanup.log.findLast(e => 'elapsed_ms' in e.data)
  return timed && 'elapsed_ms' in timed.data ? Math.round(timed.data.elapsed_ms / 1000) : 0
}

function Stats({progress}: {progress: CleanupProgress}) {
  const before = progress.cleanup.started?.free
  return (
    <div className="flex flex-col gap-4 px-4">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{progress.cleanup.done ? 'Freed' : 'Freed so far'}</span>
        <span className="text-4xl leading-none font-bold tracking-tighter tabular-nums">
          <SpinningBytes bytes={progress.freed} />
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Items done">
          {progress.count} of {progress.total}
        </Stat>
        <Stat label="Elapsed">{formatDuration(elapsedOf(progress))}</Stat>
        <Stat label="Free space">
          {before === undefined || progress.free === null ? 'not started' : `${formatBytes(before)} → ${formatBytes(progress.free)}`}
        </Stat>
      </div>
    </div>
  )
}

const KIND_TEXT: Record<Outcome['kind'], string> = {removed: 'Removed', failed: 'Not removed', kept: 'Kept', ran: 'Ran'}
const KIND_TONE: Record<Outcome['kind'], string> = {removed: 'text-foreground', failed: 'text-red-300', kept: 'text-amber-300', ran: 'text-foreground'}

function detailOf(outcome: Outcome) {
  if (outcome.key.startsWith('cmd:')) return outcome.kind === 'ran' ? 'ok' : 'failed'
  if (outcome.reason) return outcome.reason
  return `${formatBytes(outcome.bytes)}${outcome.secs > 0 ? ` in ${outcome.secs.toFixed(1)}s` : ''}`
}

interface RowProps {
  outcome: Outcome
  index: number
  count: number
  start: number
  ref: Ref<HTMLLIElement>
}

const Row = memo(function Row({outcome, index, count, start, ref}: RowProps) {
  return (
    <li
      ref={ref}
      data-index={index}
      aria-setsize={count}
      aria-posinset={index + 1}
      className="absolute top-0 left-0 grid w-full grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 border-b border-border/50 px-4 py-2 text-xs"
      style={{transform: `translateY(${start}px)`}}
    >
      <span className="text-muted-foreground tabular-nums">{(outcome.at / 1000).toFixed(1)}s</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={`font-medium ${KIND_TONE[outcome.kind]}`}>
          {KIND_TEXT[outcome.kind]} <span className="font-mono font-normal">{outcome.label}</span>
        </span>
        <span className={outcome.kind === 'removed' || outcome.kind === 'ran' ? 'text-muted-foreground' : KIND_TONE[outcome.kind]}>{detailOf(outcome)}</span>
      </span>
    </li>
  )
})

function Rows({outcomes}: {outcomes: readonly Outcome[]}) {
  const scroller = useRef<HTMLDivElement>(null)
  const newest = (index: number) => outcomes[outcomes.length - 1 - index]
  const virtualizer = useVirtualizer({
    count: outcomes.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => LOG_ROW_HEIGHT,
    getItemKey: index => newest(index)?.key ?? index,
    overscan: LOG_OVERSCAN,
  })
  return (
    <div ref={scroller} className="min-h-0 grow overflow-y-auto border-t">
      {outcomes.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">Nothing here yet.</p>
      ) : (
        <ol aria-label="Cleanup events" className="relative" style={{height: virtualizer.getTotalSize()}}>
          {virtualizer.getVirtualItems().map(virtual => {
            const outcome = newest(virtual.index)
            return outcome && <Row key={outcome.key} ref={virtualizer.measureElement} outcome={outcome} index={virtual.index} count={outcomes.length} start={virtual.start} />
          })}
        </ol>
      )}
    </div>
  )
}

function ProgressPanel({
  progress,
  open,
  onOpenChange,
  onMovie,
  log,
  setLog,
}: {
  progress: CleanupProgress
  open: boolean
  onOpenChange: (open: boolean) => void
  onMovie: () => void
  log: LogFilter
  setLog: (log: LogFilter) => void
}) {
  const reduced = useReducedMotion()
  const shown = useMemo(() => progress.outcomes.filter(FILTERS[log]), [progress.outcomes, log])
  const {done, started} = progress.cleanup
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-4 data-[side=right]:sm:max-w-md">
        <SheetHeader className="pb-0">
          <SheetTitle>Cleanup progress</SheetTitle>
          <SheetDescription>{done ? 'Finished' : started ? 'Deleting in the background' : 'Waiting for the deletion to start'}</SheetDescription>
        </SheetHeader>
        <Stats progress={progress} />
        <div className="flex items-center gap-2 px-4">
          <ToggleGroup value={[log]} onValueChange={v => v[0] && setLog(v[0] as LogFilter)} variant="outline" size="sm" aria-label="Show">
            {(Object.keys(FILTER_LABEL) as LogFilter[]).map(f => (
              <ToggleGroupItem key={f} value={f}>
                {FILTER_LABEL[f]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <Rows outcomes={shown} />
        {!reduced && (
          <div className="border-t p-4">
            <Button variant="outline" className="w-full" onClick={onMovie}>
              <Clapperboard /> Watch the movie
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

export function ProgressFooter({progress}: {progress: CleanupProgress}) {
  return (
    <footer className="flex items-center gap-2.5 border-t bg-card px-7 py-3.5">
      <div className="flex grow flex-col gap-0.5">
        <div className="text-sm font-semibold tabular-nums">
          {progress.cleanup.done ? 'Cleanup finished' : 'Approved: the deletion runs in the background'}
        </div>
        <div className="text-xs text-muted-foreground">
          {progress.plan.items.size} items · {formatBytes(progress.plan.approved)} approved · a new cleanup starts with /disk-clean
        </div>
      </div>
    </footer>
  )
}

export function CleanupTracker({
  progress,
  panel,
  setPanel,
  log,
  setLog,
  returnFocus,
}: {
  progress: CleanupProgress
  panel: boolean
  setPanel: (open: boolean) => void
  log: LogFilter
  setLog: (log: LogFilter) => void
  returnFocus: RefObject<HTMLButtonElement | null>
}) {
  const [movie, setMovie] = useState(false)
  const closeMovie = useCallback(() => {
    setMovie(false)
    returnFocus.current?.focus()
  }, [returnFocus])
  const openMovie = () => {
    setPanel(false)
    setMovie(true)
  }
  return (
    <>
      <ProgressPanel progress={progress} open={panel} onOpenChange={setPanel} onMovie={openMovie} log={log} setLog={setLog} />
      {movie && <CleanupFilm plan={progress.plan} cleanup={progress.cleanup} onClose={closeMovie} />}
    </>
  )
}

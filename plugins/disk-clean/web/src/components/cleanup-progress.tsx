import {ChevronDown, Clapperboard} from 'lucide-react'
import {memo, useCallback, useState, type ReactNode} from 'react'
import {Button} from '@/components/ui/button'
import {Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle} from '@/components/ui/sheet'
import {ToggleGroup, ToggleGroupItem} from '@/components/ui/toggle-group'
import {formatDuration, type Outcome, type CleanupProgress} from '@/lib/cleanup'
import {formatBytes} from '@/lib/data'
import {useReducedMotion} from '@/lib/motion'
import {CleanupFilm} from './cleanup-film'
import {SpinningBytes} from './numbers'

type Filter = 'all' | 'removed' | 'problems' | 'commands'

const SHOWN_ROWS = 300
const WAITING = 'Approved · Claude is showing the commands in your terminal'

const FILTERS: Record<Filter, (o: Outcome) => boolean> = {
  all: () => true,
  removed: o => o.kind === 'removed',
  problems: o => o.kind === 'failed' || o.kind === 'kept',
  commands: o => o.key.startsWith('cmd:'),
}

const FILTER_LABEL: Record<Filter, string> = {all: 'All', removed: 'Removed', problems: 'Problems', commands: 'Commands'}

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

function BarText({progress, lost}: {progress: CleanupProgress; lost: boolean}) {
  const {cleanup, plan} = progress
  if (cleanup.done) return <DoneText progress={progress} />
  if (lost) return 'Reconnecting…'
  if (!cleanup.started) {
    return (
      <>
        <span aria-hidden className="t-shimmer" data-text={WAITING}>
          {WAITING}
        </span>
        <span className="sr-only">{WAITING}</span>
      </>
    )
  }
  const last = progress.outcomes.at(-1)
  return (
    <>
      Deleting · {formatBytes(progress.freed)} of {formatBytes(plan.approved)} · {progress.count} of {progress.total}
      {last && <span className="text-muted-foreground"> · {last.label}</span>}
    </>
  )
}

function ProgressBar({progress, lost, onOpen}: {progress: CleanupProgress; lost: boolean; onOpen: () => void}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
      className="relative isolate flex h-9 w-full shrink-0 items-center gap-3 overflow-hidden border-b bg-card px-7 text-left text-xs font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      <span
        aria-hidden
        className="absolute inset-0 -z-10 origin-left bg-blue-400/15 transition-transform duration-(--duration-very-slow) ease-(--ease-smooth-out) motion-reduce:transition-none"
        style={{transform: `scaleX(${share(progress)})`}}
      />
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-blue-400 transition-transform duration-(--duration-very-slow) ease-(--ease-smooth-out) motion-reduce:transition-none"
        style={{transform: `scaleX(${share(progress)})`}}
      />
      <span className="min-w-0 grow truncate">
        <BarText progress={progress} lost={lost} />
      </span>
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        Details <ChevronDown className="size-3.5" />
      </span>
    </button>
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

const Row = memo(function Row({outcome}: {outcome: Outcome}) {
  return (
    <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 border-b border-border/50 px-4 py-2 text-xs">
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
  const shown = outcomes.slice(-SHOWN_ROWS).toReversed()
  if (shown.length === 0) return <p className="px-4 py-6 text-xs text-muted-foreground">Nothing here yet.</p>
  return (
    <>
      <ol aria-label="Cleanup events" className="flex flex-col">
        {shown.map(o => (
          <Row key={o.key} outcome={o} />
        ))}
      </ol>
      {outcomes.length > SHOWN_ROWS && <p className="px-4 py-3 text-xs text-muted-foreground">{outcomes.length - SHOWN_ROWS} older rows not shown</p>}
    </>
  )
}

function ProgressPanel({
  progress,
  open,
  onOpenChange,
  onMovie,
}: {
  progress: CleanupProgress
  open: boolean
  onOpenChange: (open: boolean) => void
  onMovie: () => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const reduced = useReducedMotion()
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
          <ToggleGroup value={[filter]} onValueChange={v => v[0] && setFilter(v[0] as Filter)} variant="outline" size="sm" aria-label="Show">
            {(Object.keys(FILTER_LABEL) as Filter[]).map(f => (
              <ToggleGroupItem key={f} value={f}>
                {FILTER_LABEL[f]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="min-h-0 grow overflow-y-auto border-t">
          <Rows outcomes={progress.outcomes.filter(FILTERS[filter])} />
        </div>
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

export function CleanupTracker({progress, lost}: {progress: CleanupProgress; lost: boolean}) {
  const [panel, setPanel] = useState(false)
  const [movie, setMovie] = useState(false)
  const closeMovie = useCallback(() => setMovie(false), [])
  const openMovie = () => {
    setPanel(false)
    setMovie(true)
  }
  return (
    <>
      <ProgressBar progress={progress} lost={lost} onOpen={() => setPanel(true)} />
      <ProgressPanel progress={progress} open={panel} onOpenChange={setPanel} onMovie={openMovie} />
      {movie && <CleanupFilm plan={progress.plan} cleanup={progress.cleanup} onClose={closeMovie} />}
    </>
  )
}

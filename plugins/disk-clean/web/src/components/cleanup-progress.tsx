import {Activity, Clapperboard, Trash2, Undo2} from 'lucide-react'
import {useVirtualizer} from '@tanstack/react-virtual'
import {useNavigate, useSearch} from '@tanstack/react-router'
import {memo, useMemo, useRef, type ReactNode, type Ref, type RefObject} from 'react'
import {Button} from '@/components/ui/button'
import {Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle} from '@/components/ui/sheet'
import {ToggleGroup, ToggleGroupItem} from '@/components/ui/toggle-group'
import {counted, formatBytes, plural, tilde} from '@/lib/data'
import {useHome} from '@/lib/page-data'
import type {Db} from '@/lib/db'
import {formatDuration, formatUntil, jobRunning, resultBytes, resultOf, useMovie, type CleanupProgress, type Outcome} from '@/lib/progress'
import {useBack} from '@/lib/navigation'
import {LOG_FILTERS, type LogFilter, type Overlay} from '@/lib/search'
import {useReducedMotion} from '@/lib/motion'
import {CleanupFilm} from './cleanup-film'
import {SpinningBytes} from './numbers'

const LOG_ROW_HEIGHT = 52
const LOG_OVERSCAN = 10
const WAITING = 'Approved · Claude is showing the commands in your terminal'

const FILTERS: Record<LogFilter, (o: Outcome) => boolean> = {
  all: () => true,
  removed: o => o.kind === 'removed' || o.kind === 'held' || o.kind === 'freed' || o.kind === 'restored',
  problems: o => o.kind === 'failed' || o.kind === 'kept',
  commands: o => o.key.startsWith('cmd:'),
}

const FILTER_LABEL: Record<LogFilter, string> = {all: 'All', removed: 'Removed', problems: 'Problems', commands: 'Commands'}

function signedBytes(n: number) {
  return `${n < 0 ? '−' : '+'}${formatBytes(Math.abs(n))}`
}

function share(progress: CleanupProgress) {
  const {cleanup, handled, count, total, plan} = progress
  if (cleanup.job && !cleanup.job.done) return cleanup.job.bytes > 0 ? Math.min(1, handled / cleanup.job.bytes) : 0
  if (cleanup.done) return 1
  const bytes = plan.approved > 0 ? handled / plan.approved : 0
  return Math.min(1, Math.max(bytes, total > 0 ? count / total : 0))
}

function problemCount(n: number, label: string, tone: string) {
  return (
    <span className={n > 0 ? tone : undefined}>
      {' · '}
      {counted(n)} {label}
    </span>
  )
}

function Problems({progress}: {progress: CleanupProgress}) {
  const latest = [...progress.byKey.values()]
  return (
    <>
      {problemCount(latest.filter(o => o.kind === 'kept').length, 'kept', 'text-amber-300')}
      {problemCount(latest.filter(o => o.kind === 'failed').length, 'not removed', 'text-red-300')}
    </>
  )
}

function HeldText({progress}: {progress: CleanupProgress}) {
  return (
    <>
      Held {formatBytes(progress.held)} · not freed yet · undo until {formatUntil(progress.holdUntil)}
      {progress.freed > 0 && ` · freed ${formatBytes(progress.freed)}`}
      <Problems progress={progress} />
    </>
  )
}

function DoneText({progress}: {progress: CleanupProgress}) {
  if (progress.held > 0) return <HeldText progress={progress} />
  const latest = [...progress.byKey.values()]
  if (progress.restored > 0) {
    return (
      <>
        Restored {formatBytes(progress.restored)} · nothing is held
        {progress.freed > 0 && ` · freed ${formatBytes(progress.freed)}`}
        <Problems progress={progress} />
      </>
    )
  }
  const removed = latest.filter(o => o.kind === 'removed' || o.kind === 'freed').length
  return (
    <>
      Freed {formatBytes(progress.freed)} · {counted(removed)} removed
      <Problems progress={progress} />
    </>
  )
}

function JobText({progress}: {progress: CleanupProgress}) {
  const job = progress.cleanup.job
  if (!job) return null
  const verb = job.kind === 'free' ? 'Freeing' : 'Undoing'
  return (
    <>
      {verb} · {formatBytes(progress.handled)} of {formatBytes(job.bytes)} · {plural(job.count, 'held item', 'held items')}
    </>
  )
}

function AbandonedText({progress, reason}: {progress: CleanupProgress; reason: string}) {
  if (!progress.cleanup.started) return <span className="text-red-300">The cleanup did not start · {reason}</span>
  return (
    <span className="text-red-300">
      The cleanup stopped · {reason} · freed {formatBytes(progress.freed)}
    </span>
  )
}

const LOST = 'Lost contact with disk-clean: the cleanup keeps running; reload to reconnect'

const LINK_TEXT = {reconnecting: 'Reconnecting to disk-clean…', lost: LOST}

export function BarText({progress}: {progress: CleanupProgress}) {
  const {cleanup, plan} = progress
  if (progress.link !== 'live') return <span className="text-red-300">{LINK_TEXT[progress.link]}</span>
  if (jobRunning(progress)) return <JobText progress={progress} />
  if (cleanup.done) return <DoneText progress={progress} />
  if (cleanup.abandoned) return <AbandonedText progress={progress} reason={cleanup.abandoned.reason} />
  if (!cleanup.started) return <span className="t-pulse">{WAITING}</span>
  const last = progress.outcomes.at(-1)
  return (
    <>
      Cleaning up · {formatBytes(progress.handled)} of {formatBytes(plan.approved)} · {counted(progress.count)} of {counted(progress.total)}
      {last && <span className="text-muted-foreground"> · {last.label}</span>}
    </>
  )
}

export function ProgressTrack({progress}: {progress: CleanupProgress}) {
  const {started, done, abandoned} = progress.cleanup
  const waiting = !started && !done && !abandoned && !jobRunning(progress)
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
  return Math.round(progress.elapsed / 1000)
}

function FreeSpace({progress}: {progress: CleanupProgress}) {
  const before = progress.cleanup.started?.free
  if (progress.freeChange !== null) return <Stat label="Free space change, all apps">{signedBytes(progress.freeChange)}</Stat>
  return <Stat label="Free space">{before === undefined || progress.free === null ? 'not started' : `${formatBytes(before)} → ${formatBytes(progress.free)}`}</Stat>
}

function headlineOf(progress: CleanupProgress) {
  const result = resultOf(progress)
  if (result === 'held') return {label: 'Held, not freed yet', note: `Freed ${formatBytes(progress.freed)} · undo until ${formatUntil(progress.holdUntil)}`}
  if (result === 'restored') return {label: 'Restored', note: `Nothing is held · freed ${formatBytes(progress.freed)}`}
  return {label: progress.cleanup.done ? 'Freed' : 'Freed so far', note: ''}
}

function Stats({progress}: {progress: CleanupProgress}) {
  const {label, note} = headlineOf(progress)
  return (
    <div className="flex flex-col gap-4 px-4">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-4xl leading-none font-bold tracking-tighter tabular-nums">
          <SpinningBytes bytes={resultBytes(progress)} />
        </span>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Items done">
          {counted(progress.count)} of {counted(progress.total)}
        </Stat>
        <Stat label="Elapsed">{formatDuration(elapsedOf(progress))}</Stat>
        <FreeSpace progress={progress} />
      </div>
    </div>
  )
}

const KIND_TEXT: Record<Outcome['kind'], string> = {
  removed: 'Removed',
  failed: 'Not removed',
  kept: 'Kept',
  ran: 'Ran',
  held: 'Held',
  freed: 'Freed',
  restored: 'Restored',
}
const KIND_TONE: Record<Outcome['kind'], string> = {
  removed: 'text-foreground',
  failed: 'text-red-300',
  kept: 'text-amber-300',
  ran: 'text-foreground',
  held: 'text-sky-300',
  freed: 'text-foreground',
  restored: 'text-foreground',
}
const QUIET = new Set<Outcome['kind']>(['removed', 'ran', 'held', 'freed', 'restored'])

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
        <span className={QUIET.has(outcome.kind) ? 'text-muted-foreground' : KIND_TONE[outcome.kind]}>{detailOf(outcome)}</span>
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
    getItemKey: index => newest(index)?.id ?? index,
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
            return outcome && <Row key={outcome.id} ref={virtualizer.measureElement} outcome={outcome} index={virtual.index} count={outcomes.length} start={virtual.start} />
          })}
        </ol>
      )}
    </div>
  )
}

const PANEL_JOB = {free: 'Freeing the held items for good', undo: 'Putting the held items back'}
const FOOTER_JOB = {free: 'Freeing the held items…', undo: 'Putting the held items back…'}

function runningJob(progress: CleanupProgress) {
  return jobRunning(progress) ? progress.cleanup.job : null
}

function panelState(progress: CleanupProgress) {
  const {cleanup} = progress
  const job = runningJob(progress)
  if (job) return PANEL_JOB[job.kind]
  if (progress.held > 0) return 'Held, not freed yet: Undo puts everything back, Free the space now deletes it for good'
  if (cleanup.done && progress.restored > 0) return 'Restored: everything held was put back'
  if (cleanup.done) return 'Finished'
  if (cleanup.abandoned) return cleanup.started ? 'Stopped before it finished' : 'The cleanup did not start'
  return cleanup.started ? 'Deleting in the background' : 'Waiting for the deletion to start'
}

function ProgressPanel({
  progress,
  open,
  onOpenChange,
  onMovie,
  log,
  setLog,
  held,
}: {
  progress: CleanupProgress
  open: boolean
  onOpenChange: (open: boolean) => void
  onMovie: () => void
  log: LogFilter
  setLog: (log: LogFilter) => void
  held: ReactNode
}) {
  const reduced = useReducedMotion()
  const shown = useMemo(() => progress.outcomes.filter(FILTERS[log]), [progress.outcomes, log])
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-4 data-[side=right]:sm:max-w-md">
        <SheetHeader className="pb-0">
          <SheetTitle>Cleanup progress</SheetTitle>
          <SheetDescription>{panelState(progress)}</SheetDescription>
        </SheetHeader>
        <Stats progress={progress} />
        {held && <div className="px-4">{held}</div>}
        <div className="flex items-center gap-2 px-4">
          <ToggleGroup value={[log]} onValueChange={v => v[0] && setLog(v[0] as LogFilter)} variant="outline" size="sm" aria-label="Show">
            {LOG_FILTERS.map(f => (
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

function footerTitle(progress: CleanupProgress) {
  const {cleanup} = progress
  const job = runningJob(progress)
  if (job) return FOOTER_JOB[job.kind]
  if (progress.held > 0) return `Held ${formatBytes(progress.held)} · not freed yet`
  if (cleanup.done && progress.restored > 0) return `Restored ${formatBytes(progress.restored)} · nothing is held`
  if (cleanup.done) return 'Cleanup finished'
  if (cleanup.abandoned) return cleanup.started ? 'The cleanup stopped before it finished' : 'The cleanup did not start'
  return 'Approved: the deletion runs in the background'
}

function FooterFigures({progress}: {progress: CleanupProgress}) {
  if (progress.freeChange === null) return null
  return <>Freed {formatBytes(progress.freed)} · </>
}

const NOT_DONE_SHOWN = 3

function NotDone({progress}: {progress: CleanupProgress}) {
  const home = useHome()
  const problems = [...progress.byKey.values()].filter(o => o.kind === 'failed' || o.kind === 'kept')
  if (problems.length === 0) return null
  const shown = problems.slice(0, NOT_DONE_SHOWN)
  return (
    <ul aria-label="Not done" className="flex flex-col gap-0.5 text-xs">
      {shown.map(o => (
        <li key={o.key} className={`truncate ${o.kind === 'failed' ? 'text-red-300' : 'text-amber-300'}`}>
          {o.kind === 'failed' ? 'Not removed' : 'Kept'} <span className="font-mono">{tilde(o.label, home)}</span>
          {o.reason && `: ${o.reason}`}
        </li>
      ))}
      {problems.length > shown.length && <li className="text-muted-foreground">{plural(problems.length - shown.length, 'more in Details', 'more in Details')}</li>}
    </ul>
  )
}

function HoldNote({progress}: {progress: CleanupProgress}) {
  if (progress.held === 0) return null
  return <>undo available until {formatUntil(progress.holdUntil)}, then freed by the next disk-clean run · </>
}

export function ProgressFooter({progress, held}: {progress: CleanupProgress; held?: ReactNode}) {
  return (
    <footer className="flex items-center gap-2.5 border-t bg-card px-7 py-3.5">
      <div className="flex grow flex-col gap-0.5">
        <div className="text-sm font-semibold tabular-nums">{footerTitle(progress)}</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          <FooterFigures progress={progress} />
          <HoldNote progress={progress} />
          {plural(progress.plan.items.size, 'item', 'items')} · {formatBytes(progress.plan.approved)} approved · a new cleanup starts with /disk-clean
        </div>
        <NotDone progress={progress} />
      </div>
      {held}
    </footer>
  )
}

export function HeldActions({
  progress,
  busy,
  error,
  onUndo,
  onFree,
}: {
  progress: CleanupProgress
  busy: boolean
  error: ReactNode
  onUndo: () => void
  onFree: () => void
}) {
  const offered = progress.held > 0 && progress.cleanup.done !== null
  if (!offered && !error) return null
  const away = progress.link !== 'live'
  const waiting = busy || jobRunning(progress) || away
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {error}
      {offered && away && <span className="text-xs text-red-300">Undo and Free wait until disk-clean is reachable again</span>}
      {offered && (
        <>
          <Button variant="outline" disabled={waiting} onClick={onUndo}>
            <Undo2 /> Undo
          </Button>
          <Button disabled={waiting} aria-haspopup="dialog" onClick={onFree}>
            <Trash2 /> Free the space now
          </Button>
        </>
      )}
    </div>
  )
}

export function CleanupTracker({db, progress, returnFocus, held}: {db: Db; progress: CleanupProgress; returnFocus: RefObject<HTMLButtonElement | null>; held: ReactNode}) {
  const movie = useMovie(db)
  const overlay = useSearch({strict: false, select: search => search.overlay})
  const log = useSearch({strict: false, select: search => search.log}) ?? 'all'
  const take = useSearch({strict: false, select: search => search.take}) ?? 0
  const navigate = useNavigate()
  const back = useBack()
  const close = () => back({to: '.', search: prev => ({...prev, overlay: undefined, log: undefined, take: undefined})})
  const layer = (patch: {overlay?: Overlay; log?: LogFilter; take?: number}) => navigate({to: '.', search: prev => ({...prev, ...patch}), replace: true})
  return (
    <>
      <ProgressPanel
        progress={progress}
        open={overlay === 'progress'}
        onOpenChange={open => open || close()}
        onMovie={() => layer({overlay: 'movie', take: 0})}
        log={log}
        setLog={next => layer({log: next})}
        held={held}
      />
      <CleanupFilm
        {...movie}
        held={held}
        open={overlay === 'movie'}
        take={take}
        onReplay={() => layer({take: take + 1})}
        onClose={close}
        returnFocus={returnFocus}
      />
    </>
  )
}

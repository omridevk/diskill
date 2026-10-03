import {useGSAP} from '@gsap/react'
import {X} from 'lucide-react'
import {useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from 'react'
import {Button} from '@/components/ui/button'
import {formatDuration, outcomes, totalsOf, type Cleanup, type FilmPlan, type Outcome, type Totals} from '@/lib/cleanup'
import {formatBytes} from '@/lib/data'
import {createFilm, pump, replay, type Film as FilmState} from '@/lib/film'
import {cssMs} from '@/lib/motion'
import {DISK_COLORS} from './disk-donut'
import {BurningFilm} from './radiant/burning-film'
import ParticleText from './react-bits/particle-text'
import Shredder from './react-bits/shredder'

const WAITING = 'Waiting for the deletion to start'
const CARDS = 8
const SHRED_FALL = 90

interface FilmProps {
  plan: FilmPlan
  cleanup: Cleanup
}

function scaleOf(total: number, free: number) {
  return total > 0 ? Math.max(0, total - free) / total : 0
}

function bySection(plan: FilmPlan, removed: readonly Outcome[]) {
  return plan.sections
    .map(s => ({section: s, items: removed.filter(o => o.section === s.id)}))
    .concat([{section: {id: '', title: 'Other', bytes: 0, count: 0}, items: removed.filter(o => !plan.sections.some(s => s.id === o.section))}])
    .filter(group => group.items.length > 0)
}

function Bar({label, used, freed, children}: {label: string; used: number; freed?: {from: number; to: number}; children?: ReactNode}) {
  return (
    <div className="flex w-full items-center gap-3 text-xs text-muted-foreground">
      <span className="w-10 text-left">{label}</span>
      <div className="relative h-2.5 grow rounded-full" style={{background: DISK_COLORS.free}}>
        {freed && <div className="absolute inset-0 origin-left rounded-full" style={{background: DISK_COLORS.selected, transform: `scaleX(${freed.from})`}} />}
        <div
          data-film={freed ? 'after-used' : undefined}
          data-from={freed?.from}
          data-to={freed?.to}
          className="absolute inset-0 origin-left rounded-full"
          style={{background: DISK_COLORS.used, transform: `scaleX(${freed ? freed.to : used})`}}
        />
        {children}
      </div>
    </div>
  )
}

function Bars({plan, done, reclaimed}: {plan: FilmPlan; done: NonNullable<Cleanup['done']>; reclaimed: number}) {
  const before = scaleOf(plan.total, done.free_before)
  const after = scaleOf(plan.total, done.free_after)
  return (
    <div data-film="bars" className="flex w-full max-w-xl flex-col gap-2">
      <Bar label="before" used={before} />
      <Bar label="after" used={after} freed={{from: before, to: after}}>
        <svg
          data-film="bracket"
          aria-hidden
          className="absolute -top-3 h-2 overflow-visible"
          style={{left: `${after * 100}%`, width: `${Math.max(0, before - after) * 100}%`}}
          viewBox="0 0 100 8"
          preserveAspectRatio="none"
        >
          <path d="M0 8V0H100V8" fill="none" stroke={DISK_COLORS.selected} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
      </Bar>
      <div className="text-xs text-muted-foreground">
        free space {formatBytes(done.free_before)} → {formatBytes(done.free_after)} · {formatBytes(reclaimed)} back
      </div>
    </div>
  )
}

function Tile({label, children}: {label: string; children: ReactNode}) {
  return (
    <div data-film="tile" className="flex min-w-0 flex-col gap-1 rounded-lg border border-white/10 bg-zinc-900/70 px-4 py-3 text-left">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-lg font-semibold tabular-nums">{children}</span>
    </div>
  )
}

function ProblemTile({label, rows}: {label: string; rows: readonly Outcome[]}) {
  return (
    <details data-film="tile" className="min-w-0 rounded-lg border border-white/10 bg-zinc-900/70 px-4 py-3 text-left">
      <summary className="flex cursor-pointer list-none flex-col gap-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span data-ticker={rows.length} className="text-lg font-semibold tabular-nums">
          {rows.length}
        </span>
      </summary>
      <ul className="mt-2 flex flex-col gap-1 text-xs">
        {rows.map(o => (
          <li key={o.key} className="flex flex-col">
            <span className="truncate font-mono">{o.label}</span>
            <span className="text-muted-foreground">{o.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function Tiles({totals}: {totals: Totals}) {
  return (
    <div className="grid w-full grid-cols-3 gap-3">
      <Tile label="items removed">
        <span data-ticker={totals.removed.length}>{totals.removed.length}</span>
      </Tile>
      <Tile label="sections">
        <span data-ticker={totals.sections}>{totals.sections}</span>
      </Tile>
      <Tile label="biggest item">{totals.biggest ? `${formatBytes(totals.biggest.bytes)} · ${totals.biggest.label}` : 'none'}</Tile>
      <Tile label="time taken">{formatDuration(totals.seconds)}</Tile>
      <ProblemTile label="kept" rows={totals.kept} />
      <ProblemTile label="not removed" rows={totals.failed} />
    </div>
  )
}

function CreditList({plan, totals}: {plan: FilmPlan; totals: Totals}) {
  return (
    <>
      {bySection(plan, totals.removed).map(({section, items}) => (
        <li key={section.id} className="flex flex-col gap-1">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{section.title}</span>
          {items.map(o => (
            <span key={o.key} className="truncate font-mono text-xs">
              {o.label}
            </span>
          ))}
        </li>
      ))}
      <li className="pt-4 text-sm text-muted-foreground">and that's everything</li>
    </>
  )
}

function Ring() {
  return (
    <svg data-part="ring" viewBox="0 0 24 24" aria-hidden className="size-6 shrink-0">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2.5" />
      <circle data-part="arc" cx="12" cy="12" r="10" fill="none" stroke={DISK_COLORS.selected} strokeWidth="2.5" transform="rotate(-90 12 12)" />
      <path data-part="check" d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Card() {
  return (
    <div
      data-film="card"
      className="group absolute inset-0 flex flex-col justify-center gap-1.5 rounded-xl border border-white/20 bg-zinc-900 px-5 opacity-0 shadow-xl shadow-black/60 data-[kind=failed]:border-red-400/60 data-[kind=kept]:border-amber-300/50"
    >
      <div className="flex min-w-0 items-center gap-2">
        <svg data-part="lock" viewBox="0 0 24 24" aria-hidden className="hidden size-4 shrink-0 text-amber-200 group-data-[kind=kept]:block">
          <rect width="18" height="11" x="3" y="11" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        <span data-part="label" className="truncate font-mono text-sm text-zinc-50" />
      </div>
      <div className="flex min-w-0 justify-between gap-3 text-sm text-zinc-300">
        <span data-part="size" className="shrink-0 tabular-nums" />
        <span data-part="reason" className="truncate text-red-300 group-data-[kind=kept]:text-amber-200" />
      </div>
    </div>
  )
}

function Tray({title, rows}: {title: string; rows: readonly Outcome[]}) {
  return (
    <div data-film="build" className="flex flex-col gap-2">
      <span className="text-xs font-semibold tracking-wide text-zinc-300 uppercase">{title}</span>
      <ul className="flex flex-col gap-1.5">
        {rows.map(o => (
          <li key={o.key} data-film="tray-row" data-key={o.key} className="flex flex-col rounded-md border border-white/15 bg-zinc-900 px-3 py-2 text-sm opacity-0">
            <span className="truncate font-mono">{o.label}</span>
            <span className={title === 'Kept' ? 'text-amber-200' : 'text-red-300'}>{o.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Slot({shred}: {shred: Outcome | null}) {
  const items = useMemo(() => (shred ? [{id: shred.key, label: shred.label, size: formatBytes(shred.bytes)}] : []), [shred])
  return (
    <div data-film="slot" className="relative h-[88px] w-full max-w-[440px]">
      {Array.from({length: CARDS}, (_, i) => (
        <Card key={i} />
      ))}
      <div data-film="chip" className="absolute inset-x-0 top-full mx-auto mt-3 w-fit rounded-full bg-zinc-800 px-3 py-1 text-xs tabular-nums opacity-0" />
      {shred && (
        <div aria-hidden className="absolute inset-x-0 top-0">
          <Shredder
            key={shred.key}
            items={items}
            renderItem={item => (
              <div className="flex justify-between gap-3 truncate rounded-md border border-white/15 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-200">
                <span className="truncate">{item.label}</span>
                <span>{item.size}</span>
              </div>
            )}
            autoAnimate
            autoDelay={0}
            width={440}
            height={34 + SHRED_FALL + 8}
            fallHeight={SHRED_FALL}
            slitColor="#64748b"
            color="#d4d4d8"
          />
        </div>
      )}
    </div>
  )
}

function Stage({plan, cleanup, shred}: {plan: FilmPlan; cleanup: Cleanup; shred: Outcome | null}) {
  const all = useMemo(() => outcomes(plan, cleanup.log), [plan, cleanup.log])
  const kept = all.filter(o => o.kind === 'kept')
  const failed = all.filter(o => o.kind === 'failed')
  const commands = all.filter(o => o.key.startsWith('cmd:'))
  const startFree = cleanup.started?.free ?? 0
  return (
    <div data-film="stage" className="invisible absolute inset-0 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] grid-rows-[1fr_auto] gap-x-10 gap-y-6 p-12">
      <ol data-film="leave" className="flex flex-col gap-3 self-center rounded-xl border border-white/10 bg-zinc-950 p-5">
        {plan.sections.map(s => (
          <li key={s.id} data-film="build" className="flex min-w-0 items-center gap-3">
            <div data-section={s.id} className="flex min-w-0 grow items-center gap-3">
              <Ring />
              <span className="truncate text-sm">{s.title}</span>
              <span data-part="left" className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatBytes(s.bytes)}
              </span>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-col items-center justify-center gap-8">
        <div data-film="leave">
          <div data-film="counter-box" className="flex flex-col items-center gap-1 opacity-0">
            <output data-film="counter" aria-label="Reclaimed" className="inline-block min-w-[7ch] text-center text-7xl leading-none font-bold tracking-tighter tabular-nums [contain:layout_paint]">
              0 B
            </output>
            <div className="text-sm text-muted-foreground">
              of{' '}
              <span data-film="of-total" className="inline-block font-medium text-foreground opacity-0">
                {formatBytes(plan.approved)}
              </span>{' '}
              approved
            </div>
          </div>
        </div>
        <div data-film="leave" className="flex w-full justify-center">
          <Slot shred={shred} />
        </div>
      </div>
      <div data-film="leave" className="flex flex-col gap-6 self-center rounded-xl border border-white/10 bg-zinc-950 p-5">
        <Tray title="Kept" rows={kept} />
        <Tray title="Not removed" rows={failed} />
      </div>
      <div data-film="leave" className="col-span-3 flex flex-col gap-3 rounded-xl border border-white/10 bg-zinc-950 px-5 py-4">
        <ul className="flex flex-col gap-1">
          {commands.map(o => (
            <li key={o.key} data-film="command" data-key={o.key} className="flex items-center gap-2 font-mono text-xs opacity-0">
              <span className="text-muted-foreground">$</span>
              <span data-part="label">{o.label}</span>
              <svg data-part="status" viewBox="0 0 24 24" aria-label={o.kind === 'failed' ? 'failed' : 'ok'} className={`size-3.5 ${o.kind === 'failed' ? 'text-red-300' : 'text-sky-300'}`}>
                <path d={o.kind === 'failed' ? 'M18 6 6 18M6 6l12 12' : 'M20 6 9 17l-5-5'} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </li>
          ))}
        </ul>
        <div data-film="build" className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>disk</span>
          <div className="relative h-2 grow overflow-hidden rounded-full" style={{background: DISK_COLORS.free}}>
            <div data-film="freed-bar" className="absolute inset-0 origin-left" style={{background: DISK_COLORS.selected}} />
            <div data-film="used" className="absolute inset-0 origin-left" style={{background: DISK_COLORS.used}} />
          </div>
          <span className="shrink-0">
            free <span data-film="free" className="tabular-nums">{formatBytes(startFree)}</span>
          </span>
        </div>
      </div>
    </div>
  )
}

function Finale({plan, cleanup, particles, onReplay}: {plan: FilmPlan; cleanup: Cleanup; particles: boolean; onReplay: () => void}) {
  const totals = totalsOf(outcomes(plan, cleanup.log), cleanup.done)
  if (!cleanup.done) return null
  return (
    <div data-film="finale" className="invisible absolute inset-0 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-8 px-6 py-14 text-center">
        <h2 data-film="freed-heading" className="text-2xl font-semibold tracking-tight">
          You freed
        </h2>
        <div className="relative grid h-24 w-full place-items-center">
          <div data-film="freed" className="text-[96px] leading-none font-bold tracking-tighter tabular-nums opacity-0">
            {formatBytes(totals.reclaimed)}
          </div>
          <div data-film="particles" aria-hidden className="pointer-events-none absolute inset-x-0 -top-28 h-[320px]">
            {particles && (
              <ParticleText
                text={formatBytes(totals.reclaimed)}
                fontFamily="'Geist Variable'"
                fontSize={96}
                fontWeight={700}
                particleSize={2.2}
                density={2}
                color="#f5f8ff"
                highlightColor="#a9c8f0"
                gatherDuration={cssMs('--gather-dur', 1600)}
                style={{minHeight: 0, height: 320}}
              />
            )}
          </div>
        </div>
        <Bars plan={plan} done={cleanup.done} reclaimed={totals.reclaimed} />
        <Tiles totals={totals} />
        <div data-film="credits" className="t-credits h-64 w-full overflow-hidden opacity-0">
          <ol data-film="credits-list" className="flex flex-col gap-4 pt-24 pb-24">
            <CreditList plan={plan} totals={totals} />
          </ol>
        </div>
        <button data-film="replay" type="button" onClick={onReplay} className="invisible rounded-md border border-white/15 px-4 py-2 text-sm">
          Replay
        </button>
      </div>
    </div>
  )
}

function useFilm(plan: FilmPlan, cleanup: Cleanup) {
  const root = useRef<HTMLDivElement>(null)
  const latest = useRef(cleanup)
  const film = useRef<FilmState | null>(null)
  const [shred, setShred] = useState<Outcome | null>(null)
  const [particles, setParticles] = useState(false)
  const [running, setRunning] = useState(true)
  const {contextSafe} = useGSAP(
    (_, contextSafe) => {
      if (!root.current || !contextSafe) return
      const tail = contextSafe(() => pump(film.current, latest.current, true))
      const ready = contextSafe(() => {
        if (film.current) film.current.ready = true
        pump(film.current, latest.current)
      })
      const visible = contextSafe(() => {
        const current = film.current
        if (document.hidden || !current) return
        current.flood = latest.current.log.length > current.processed
        pump(current, latest.current)
      })
      film.current = createFilm(root.current, plan, {shred: setShred, particles: setParticles, running: setRunning}, tail, ready)
      document.addEventListener('visibilitychange', visible)
      return () => document.removeEventListener('visibilitychange', visible)
    },
    {scope: root},
  )
  useLayoutEffect(() => {
    latest.current = cleanup
    contextSafe(() => pump(film.current, cleanup))()
  }, [cleanup, contextSafe])
  const onReplay = () => {
    if (film.current) replay(film.current)
  }
  return {root, shred, particles, running, onReplay}
}

function Film({plan, cleanup}: FilmProps) {
  const {root, shred, particles, running, onReplay} = useFilm(plan, cleanup)
  const waiting = cleanup.keys.has('waiting') && !cleanup.started
  return (
    <div ref={root} className="fixed inset-0 isolate z-50 overflow-hidden text-foreground">
      <div data-film="backdrop" className="absolute inset-0 -z-10 bg-background opacity-0">
        <div data-film="film" className="absolute inset-0">
          <BurningFilm running={running} className="absolute inset-0" />
        </div>
      </div>
      <section className="absolute inset-x-0 top-[34%] flex flex-col items-center gap-4 text-center">
        <div data-film="total" className="text-[96px] leading-none font-bold tracking-tighter tabular-nums">
          {formatBytes(plan.approved)}
        </div>
        <div data-film="caption" className="flex flex-col gap-1">
          <p className="text-2xl font-semibold tracking-tight">approved for deletion</p>
          <p className="text-sm text-muted-foreground">
            {plan.items.size} items in {plan.sections.length} sections
          </p>
        </div>
        <p data-film="waiting" className="text-sm opacity-0">
          <span className={waiting ? 't-shimmer' : undefined} data-text={WAITING}>
            {WAITING}
          </span>
        </p>
      </section>
      <Stage plan={plan} cleanup={cleanup} shred={shred} />
      <Finale plan={plan} cleanup={cleanup} particles={particles} onReplay={onReplay} />
    </div>
  )
}

export function CleanupFilm({plan, cleanup, onClose}: {plan: FilmPlan; cleanup: Cleanup; onClose: () => void}) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    close.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div role="dialog" aria-modal="true" aria-label="Cleanup movie" className="fixed inset-0 z-50">
      <Film plan={plan} cleanup={cleanup} />
      <Button ref={close} variant="secondary" size="sm" className="absolute top-4 right-4 z-[60]" onClick={onClose}>
        <X /> Close
      </Button>
    </div>
  )
}

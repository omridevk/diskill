import {HardDrive} from 'lucide-react'
import {useEffect, useMemo, useState, type ReactNode} from 'react'
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs'
import {decide, preview} from '@/lib/api'
import {formatBytes, type Loaded} from '@/lib/data'
import {useScan} from '@/lib/live'
import {cssMs, useReducedMotion, useShownOnMount} from '@/lib/motion'
import {useSelection, type Selection} from '@/lib/selection'
import {ActionBar} from './components/action-bar'
import {Cleanup} from './components/cleanup'
import {Insights} from './components/insights'
import {PreviewDialog, type Plan} from './components/preview-dialog'
import {BurningFilm} from './components/radiant/burning-film'
import ParticleText from './components/react-bits/particle-text'
import Shredder from './components/react-bits/shredder'
import {ScanCounter, useScanHero} from './components/scan-hero'
import {ScanStatus} from './components/scan-status'
import {SkeletonReveal} from './components/skeleton-reveal'
import {Storage} from './components/storage'
import {Summary} from './components/summary'

interface Outcome {
  title: string
  body: string
  approved: boolean
  bytes: number
  labels: string[]
}

const SHREDDED = 6
const SHRED_ROW = 34
const SHRED_GAP = 8
const SHRED_FALL = 110

function useAfterGather() {
  const [gathered, setGathered] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setGathered(true), cssMs('--gather-dur', 1600))
    return () => clearTimeout(timer)
  }, [])
  return gathered
}

function ShredQueue({labels}: {labels: string[]}) {
  const reduced = useReducedMotion()
  const gathered = useAfterGather()
  const [left, setLeft] = useState(labels.length)
  const items = useMemo(() => labels.map(id => ({id})), [labels])
  if (reduced || items.length === 0) return null
  return (
    <div aria-hidden className="t-shred absolute top-full left-1/2 w-[420px] max-w-full -translate-x-1/2 pt-10" data-done={left === 0 ? '' : undefined}>
      <Shredder
        items={items}
        renderItem={item => (
          <div className="truncate rounded-md border border-white/15 bg-zinc-800 px-3 py-2 text-left font-mono text-xs text-zinc-200">{item.id}</div>
        )}
        autoAnimate={gathered && left > 0}
        onShred={() => setLeft(n => n - 1)}
        width={420}
        height={items.length * (SHRED_ROW + SHRED_GAP) + SHRED_FALL + 4}
        gap={SHRED_GAP}
        fallHeight={SHRED_FALL}
        slitColor="#64748b"
        color="#d4d4d8"
      />
    </div>
  )
}

function Approved({title, body, bytes, labels}: Outcome) {
  const lines = useShownOnMount()
  return (
    <div className="relative isolate flex min-h-svh flex-col items-center justify-center overflow-hidden p-6 text-center">
      <BurningFilm className="t-film fixed inset-0 -z-10" />
      <div aria-hidden className="t-film-scrim fixed inset-0 -z-10" />
      <div className="relative flex w-full flex-col items-center gap-1">
        <ParticleText
          text={formatBytes(bytes)}
          fontFamily="'Geist Variable'"
          fontSize={96}
          fontWeight={700}
          particleSize={2.2}
          density={2}
          color="#f5f8ff"
          highlightColor="#a9c8f0"
          gatherDuration={cssMs('--gather-dur', 1600)}
          className="max-w-3xl"
          style={{minHeight: 0, height: 320, margin: '-85px 0'}}
        />
        <div ref={lines} className="t-stagger t-stagger--after-gather flex flex-col gap-2">
          <h1 className="t-stagger-line t-stagger-line--1 text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="t-stagger-line t-stagger-line--2 text-sm text-muted-foreground">{body}</p>
        </div>
        <ShredQueue labels={labels} />
      </div>
    </div>
  )
}

function Finished({title, body}: Outcome) {
  const lines = useShownOnMount()
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2 p-6 text-center">
      <div ref={lines} className="t-stagger flex flex-col gap-2">
        <h1 className="t-stagger-line t-stagger-line--1 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="t-stagger-line t-stagger-line--2 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

function Problem({text}: {text: string}) {
  if (!text) return null
  return <div className="border-b bg-red-500/10 px-7 py-2 text-xs text-red-300">{text}.</div>
}

function Streamed({live, ready, children}: {live: boolean; ready: boolean; children: ReactNode}) {
  return live ? <SkeletonReveal ready={ready}>{children}</SkeletonReveal> : children
}

function useDecisions(token: string, selection: Selection) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [dialog, setDialog] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [done, setDone] = useState<Outcome | null>(null)
  const [error, setError] = useState('')

  const run = (task: Promise<unknown>, onDone: () => void) =>
    task.then(onDone).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))

  const openPreview = () => {
    setPreviewing(true)
    setError('')
    run(
      preview(token, selection.selected).then(setPlan),
      () => setDialog(true),
    ).finally(() => setPreviewing(false))
  }
  const approve = () =>
    run(decide(token, 'approve', selection.selected), () =>
      setDone({
        title: 'queued for deletion',
        body: 'Deletion runs in the background. You can close this tab and return to the terminal.',
        approved: true,
        bytes: selection.exactBytes,
        labels: selection.selected.toSorted((a, b) => b.bytes - a.bytes).slice(0, SHREDDED).map(i => i.label),
      }),
    )
  const cancel = () =>
    run(decide(token, 'cancel', []), () => setDone({title: 'Cancelled', body: 'Nothing was deleted. You can close this tab.', approved: false, bytes: 0, labels: []}))

  return {plan, dialog, setDialog, previewing, done, error, openPreview, approve, cancel}
}

export function App({loaded}: {loaded: Loaded}) {
  const live = loaded.live === true
  const scan = useScan(loaded)
  const {data} = scan
  const selection = useSelection(data.categories)
  const hero = useScanHero(live, scan, selection.exactBytes)
  const {plan, dialog, setDialog, previewing, done, error, openPreview, approve, cancel} = useDecisions(loaded.token, selection)
  const cleanable = useMemo(
    () => new Set(data.categories.flatMap(c => c.items.filter(i => !i.report).map(i => i.path))),
    [data.categories],
  )
  const itemCount = data.categories.reduce((sum, c) => sum + c.items.length, 0)

  if (done) return done.approved ? <Approved {...done} /> : <Finished {...done} />
  const settled = scan.walked || scan.error !== ''

  return (
    <Tabs defaultValue="cleanup" className="flex h-svh flex-col gap-0">
      <header className="flex items-center gap-4 border-b px-7 py-4">
        <div className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
          <HardDrive className="size-4" />
        </div>
        <div className="flex grow flex-col">
          <h1 className="text-[15px] font-semibold">Disk Clean</h1>
          <p className="text-xs text-muted-foreground">{itemCount} items found · nothing is deleted until you approve</p>
        </div>
        <TabsList>
          <TabsTrigger value="cleanup">Cleanup</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
        </TabsList>
      </header>
      <Summary
        data={data}
        selection={selection}
        bytes={hero.bytes}
        overlay={hero.overlay}
        counter={live && <ScanCounter scan={scan} />}
        status={live && <ScanStatus scan={scan} />}
        scanning={live && !settled}
      />
      <Problem text={scan.error && `The scan failed: ${scan.error}. Nothing can be approved`} />
      <Problem text={error && `${error}. Nothing was deleted`} />
      <TabsContent value="cleanup" className="flex min-h-0 flex-col">
        <Cleanup categories={data.categories} selection={selection} />
      </TabsContent>
      <TabsContent value="storage" className="min-h-0 overflow-auto">
        <Streamed live={live} ready={settled}>
          <Storage data={data} cleanable={cleanable} />
        </Streamed>
      </TabsContent>
      <TabsContent value="insights" className="min-h-0 overflow-auto">
        <Streamed live={live} ready={settled}>
          <Insights insights={data.insights} categories={data.categories} />
        </Streamed>
      </TabsContent>
      <ActionBar
        selection={selection}
        locked={!scan.done || scan.error !== ''}
        previewing={previewing}
        onCancel={cancel}
        onPreview={openPreview}
        onApprove={approve}
      />
      <PreviewDialog plan={plan} open={dialog} onOpenChange={setDialog} onApprove={approve} />
    </Tabs>
  )
}

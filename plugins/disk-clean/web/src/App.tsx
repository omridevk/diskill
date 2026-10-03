import {HardDrive} from 'lucide-react'
import {useMemo, useState, type ReactNode} from 'react'
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs'
import {decide, preview} from '@/lib/api'
import {filmPlan, useCleanupProgress, type CleanupProgress, type FilmPlan} from '@/lib/cleanup'
import type {Loaded, ScanData} from '@/lib/data'
import {useScan} from '@/lib/live'
import type {Scan} from '@/lib/scan'
import {useShownOnMount} from '@/lib/motion'
import {useSelection, type Selection} from '@/lib/selection'
import {ActionBar} from './components/action-bar'
import {Cleanup} from './components/cleanup'
import {BarText, CleanupTracker, DetailsButton, ProgressTrack} from './components/cleanup-progress'
import {Insights} from './components/insights'
import {PreviewDialog, type Plan} from './components/preview-dialog'
import {ScanCounter, useScanHero} from './components/scan-hero'
import {RescanButton, ScanStatus} from './components/scan-status'
import {SkeletonReveal} from './components/skeleton-reveal'
import {Storage} from './components/storage'
import {Summary} from './components/summary'

interface Outcome {
  title: string
  body: string
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

function Problems({scanError, error}: {scanError: string; error: string}) {
  return (
    <>
      <Problem text={scanError && `The scan failed: ${scanError}. Nothing can be approved`} />
      <Problem text={error && `${error}. Nothing was deleted`} />
    </>
  )
}

function Streamed({live, ready, children}: {live: boolean; ready: boolean; children: ReactNode}) {
  return live ? <SkeletonReveal ready={ready}>{children}</SkeletonReveal> : children
}

function Status({items, progress, lost}: {items: number; progress: CleanupProgress | null; lost: boolean}) {
  if (!progress) return <p className="truncate text-sm leading-5 text-muted-foreground">{items} items found · nothing is deleted until you approve</p>
  return (
    <p className="truncate text-sm leading-5 font-medium text-foreground tabular-nums">
      <BarText progress={progress} lost={lost} />
    </p>
  )
}

function Header({items, progress, lost, onDetails}: {items: number; progress: CleanupProgress | null; lost: boolean; onDetails: () => void}) {
  return (
    <header className="relative flex items-center gap-4 border-b px-7 py-4">
      <div className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
        <HardDrive className="size-4" />
      </div>
      <div className="flex min-w-0 grow flex-col">
        <h1 className="text-[15px] font-semibold">Disk Clean</h1>
        <Status items={items} progress={progress} lost={lost} />
      </div>
      {progress && <DetailsButton onClick={onDetails} />}
      <TabsList>
        <TabsTrigger value="cleanup">Cleanup</TabsTrigger>
        <TabsTrigger value="storage">Storage</TabsTrigger>
        <TabsTrigger value="insights">Insights</TabsTrigger>
      </TabsList>
      {progress && <ProgressTrack progress={progress} />}
    </header>
  )
}

function planOf(data: ScanData, selection: Selection) {
  return filmPlan(data.categories, selection.selected, selection.exactBytes, data.total)
}

function useDecisions(token: string, selection: Selection, data: ScanData, approved: boolean) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [dialog, setDialog] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [done, setDone] = useState<Outcome | null>(null)
  const [film, setFilm] = useState<FilmPlan | null>(() => (approved ? planOf(data, selection) : null))
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
  const approve = () => {
    setDialog(false)
    run(decide(token, 'approve', selection.selected), () => setFilm(planOf(data, selection)))
  }
  const cancel = () => run(decide(token, 'cancel', []), () => setDone({title: 'Cancelled', body: 'Nothing was deleted. You can close this tab.'}))

  return {plan, dialog, setDialog, previewing, done, film, error, openPreview, approve, cancel}
}

function scanProgressOf(live: boolean, scan: Scan) {
  return {tracking: live || scan.rescans > 0, settled: scan.walked || scan.rescans > 0 || scan.error !== ''}
}

export function App({loaded}: {loaded: Loaded}) {
  const live = loaded.live === true
  const {scan, rescan} = useScan(loaded)
  const {tracking, settled} = scanProgressOf(live, scan)
  const {data} = scan
  const selection = useSelection(data.categories, loaded.approved)
  const hero = useScanHero(live, scan, selection.exactBytes)
  const {plan, dialog, setDialog, previewing, done, film, error, openPreview, approve, cancel} = useDecisions(loaded.token, selection, data, loaded.approved !== undefined)
  const {progress, lost} = useCleanupProgress(loaded.token, film, loaded.openEvents)
  const approved = film !== null
  const [panel, setPanel] = useState(false)
  const openDetails = () => setPanel(true)
  const cleanable = useMemo(
    () => new Set(data.categories.flatMap(c => c.items.filter(i => !i.report).map(i => i.path))),
    [data.categories],
  )
  const itemCount = data.categories.reduce((sum, c) => sum + c.items.length, 0)

  if (done) return <Finished {...done} />

  return (
    <Tabs defaultValue="cleanup" className="flex h-svh flex-col gap-0">
      {progress && <CleanupTracker progress={progress} panel={panel} setPanel={setPanel} />}
      <Header items={itemCount} progress={progress} lost={lost} onDetails={openDetails} />
      <Summary
        data={data}
        selection={selection}
        bytes={progress ? progress.freed : hero.bytes}
        overlay={hero.overlay}
        counter={tracking && <ScanCounter scan={scan} />}
        status={
          <>
            {tracking && <ScanStatus scan={scan} />}
            <RescanButton scan={scan} approved={approved} onRescan={rescan} />
          </>
        }
        scanning={live && !settled}
        progress={progress}
      />
      <Problems scanError={scan.error} error={error} />
      <TabsContent value="cleanup" className="flex min-h-0 flex-col">
        <Cleanup categories={data.categories} selection={selection} progress={progress} />
      </TabsContent>
      <TabsContent value="storage" className="min-h-0 overflow-auto">
        <Streamed live={live} ready={settled}>
          <Storage data={data} cleanable={cleanable} selection={selection} />
        </Streamed>
      </TabsContent>
      <TabsContent value="insights" className="min-h-0 overflow-auto">
        <Streamed live={live} ready={settled}>
          <Insights insights={data.insights} categories={data.categories} />
        </Streamed>
      </TabsContent>
      <ActionBar
        key={scan.rescans}
        selection={selection}
        locked={!scan.done || scan.error !== ''}
        progress={progress}
        previewing={previewing}
        onCancel={cancel}
        onPreview={openPreview}
        onApprove={approve}
      />
      <PreviewDialog plan={plan} open={dialog} onOpenChange={setDialog} onApprove={approve} />
    </Tabs>
  )
}

import {HardDrive} from 'lucide-react'
import {useCallback, useMemo, useState, type ReactNode} from 'react'
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs'
import {decide, preview} from '@/lib/api'
import {filmPlan, type FilmPlan} from '@/lib/cleanup'
import type {Loaded, ScanData} from '@/lib/data'
import {useScan} from '@/lib/live'
import type {Scan} from '@/lib/scan'
import {useShownOnMount} from '@/lib/motion'
import {useSelection, type Selection} from '@/lib/selection'
import {ActionBar} from './components/action-bar'
import {Cleanup} from './components/cleanup'
import {CleanupFilm} from './components/cleanup-film'
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

function Streamed({live, ready, children}: {live: boolean; ready: boolean; children: ReactNode}) {
  return live ? <SkeletonReveal ready={ready}>{children}</SkeletonReveal> : children
}

function useDecisions(token: string, selection: Selection, data: ScanData) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [dialog, setDialog] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [done, setDone] = useState<Outcome | null>(null)
  const [film, setFilm] = useState<FilmPlan | null>(null)
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
    run(decide(token, 'approve', selection.selected), () => setFilm(filmPlan(data.categories, selection.selected, selection.exactBytes, data.total)))
  const cancel = () => run(decide(token, 'cancel', []), () => setDone({title: 'Cancelled', body: 'Nothing was deleted. You can close this tab.'}))

  return {plan, dialog, setDialog, previewing, done, film, error, openPreview, approve, cancel}
}

function progressOf(live: boolean, scan: Scan) {
  return {tracking: live || scan.rescans > 0, settled: scan.walked || scan.rescans > 0 || scan.error !== ''}
}

export function App({loaded}: {loaded: Loaded}) {
  const live = loaded.live === true
  const {scan, rescan} = useScan(loaded)
  const {tracking, settled} = progressOf(live, scan)
  const {data} = scan
  const selection = useSelection(data.categories)
  const hero = useScanHero(live, scan, selection.exactBytes)
  const {plan, dialog, setDialog, previewing, done, film, error, openPreview, approve, cancel} = useDecisions(loaded.token, selection, data)
  const [covered, setCovered] = useState(false)
  const cover = useCallback(() => setCovered(true), [])
  const cleanable = useMemo(
    () => new Set(data.categories.flatMap(c => c.items.filter(i => !i.report).map(i => i.path))),
    [data.categories],
  )
  const itemCount = data.categories.reduce((sum, c) => sum + c.items.length, 0)

  if (done) return <Finished {...done} />

  return (
    <>
      {!covered && (
        <Tabs defaultValue="cleanup" className="flex h-svh flex-col gap-0">
          <header data-review="top" className="flex items-center gap-4 border-b px-7 py-4">
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
            counter={tracking && <ScanCounter scan={scan} />}
            status={
              <>
                {tracking && <ScanStatus scan={scan} />}
                <RescanButton scan={scan} onRescan={rescan} />
              </>
            }
            scanning={live && !settled}
          />
          <Problem text={scan.error && `The scan failed: ${scan.error}. Nothing can be approved`} />
          <Problem text={error && `${error}. Nothing was deleted`} />
          <TabsContent data-review="content" value="cleanup" className="flex min-h-0 flex-col">
            <Cleanup categories={data.categories} selection={selection} />
          </TabsContent>
          <TabsContent data-review="content" value="storage" className="min-h-0 overflow-auto">
            <Streamed live={live} ready={settled}>
              <Storage data={data} cleanable={cleanable} selection={selection} />
            </Streamed>
          </TabsContent>
          <TabsContent data-review="content" value="insights" className="min-h-0 overflow-auto">
            <Streamed live={live} ready={settled}>
              <Insights insights={data.insights} categories={data.categories} />
            </Streamed>
          </TabsContent>
          <ActionBar
            key={scan.rescans}
            selection={selection}
            locked={!scan.done || scan.error !== ''}
            previewing={previewing}
            onCancel={cancel}
            onPreview={openPreview}
            onApprove={approve}
          />
          <PreviewDialog plan={plan} open={dialog} onOpenChange={setDialog} onApprove={approve} />
        </Tabs>
      )}
      {film && <CleanupFilm plan={film} token={loaded.token} openEvents={loaded.openEvents} onCovered={cover} />}
    </>
  )
}

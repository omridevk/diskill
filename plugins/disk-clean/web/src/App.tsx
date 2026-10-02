import {HardDrive} from 'lucide-react'
import {useEffect, useMemo, useState, type ReactNode} from 'react'
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs'
import {decide, preview} from '@/lib/api'
import {formatBytes, type Loaded} from '@/lib/data'
import {useScan} from '@/lib/live'
import {useReducedMotion, useShownOnMount} from '@/lib/motion'
import type {Scan} from '@/lib/scan'
import {useSelection, type Selection} from '@/lib/selection'
import {ActionBar} from './components/action-bar'
import {Cleanup} from './components/cleanup'
import {Insights} from './components/insights'
import {PreviewDialog, type Plan} from './components/preview-dialog'
import {ScanHero} from './components/scan-hero'
import {ScanStatus} from './components/scan-status'
import {SkeletonReveal} from './components/skeleton-reveal'
import {Storage} from './components/storage'
import {Summary} from './components/summary'

const GATHER_MS = 3000

interface Outcome {
  title: string
  body: string
  approved: boolean
}

function SuccessCheck() {
  return (
    <span className="t-success-check pb-2" data-state="in" aria-hidden>
      <svg viewBox="0 0 48 48" fill="none" className="size-12 text-emerald-400">
        <circle cx="24" cy="24" r="24" className="fill-emerald-500/15" />
        <path d="M14 24.5L21 31.5L34 17" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

function Finished({title, body, approved}: Outcome) {
  const lines = useShownOnMount()
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2 p-6 text-center">
      {approved && <SuccessCheck />}
      <div ref={lines} className="t-stagger flex flex-col gap-2">
        <h1 className="t-stagger-line t-stagger-line--1 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="t-stagger-line t-stagger-line--2 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

function useHandedOver(scan: Scan) {
  const reduced = useReducedMotion()
  const ready = scan.walked || scan.error !== ''
  const delay = scan.error || reduced ? 0 : GATHER_MS
  const [handedOver, setHandedOver] = useState(ready)
  useEffect(() => {
    if (!ready || handedOver) return
    const timer = setTimeout(() => setHandedOver(true), delay)
    return () => clearTimeout(timer)
  }, [ready, handedOver, delay])
  return handedOver
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
        title: `Approved: ${formatBytes(selection.exactBytes)} queued for deletion`,
        body: 'Deletion runs in the background. You can close this tab and return to the terminal.',
        approved: true,
      }),
    )
  const cancel = () =>
    run(decide(token, 'cancel', []), () => setDone({title: 'Cancelled', body: 'Nothing was deleted. You can close this tab.', approved: false}))

  return {plan, dialog, setDialog, previewing, done, error, openPreview, approve, cancel}
}

export function App({loaded}: {loaded: Loaded}) {
  const live = loaded.live === true
  const scan = useScan(loaded)
  const {data} = scan
  const handedOver = useHandedOver(scan)
  const selection = useSelection(data.categories)
  const {plan, dialog, setDialog, previewing, done, error, openPreview, approve, cancel} = useDecisions(loaded.token, selection)
  const cleanable = useMemo(
    () => new Set(data.categories.flatMap(c => c.items.filter(i => !i.report).map(i => i.path))),
    [data.categories],
  )
  const itemCount = data.categories.reduce((sum, c) => sum + c.items.length, 0)

  if (done) return <Finished {...done} />
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
        status={live && <ScanStatus scan={scan} />}
        hero={live && !handedOver ? <ScanHero scan={scan} /> : undefined}
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

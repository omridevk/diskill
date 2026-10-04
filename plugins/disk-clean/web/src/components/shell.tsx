import {Navigate, Outlet, useChildMatches, useMatch, useNavigate, useRouter} from '@tanstack/react-router'
import {HardDrive} from 'lucide-react'
import {createContext, use, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject} from 'react'
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs'
import {decide, heldAction, preview, type Plan} from '@/lib/api'
import {filmPlan, freeOffer, resultBytes, useCleanupProgress, type CleanupProgress, type FilmPlan} from '@/lib/cleanup'
import {homeOf, type Item, type Loaded, type ScanData} from '@/lib/data'
import {useScan} from '@/lib/live'
import type {Scan} from '@/lib/scan'
import {useShownOnMount} from '@/lib/motion'
import {useBack} from '@/lib/navigation'
import {useSelection, type Selection} from '@/lib/selection'
import {ActionBar} from './action-bar'
import {BarText, CleanupTracker, DetailsButton, HeldActions, ProgressTrack} from './cleanup-progress'
import {ConfirmDialog} from './confirm-dialog'
import {FreeDialog} from './free-dialog'
import {ScanCounter, useScanHero} from './scan-hero'
import {RescanButton, ScanStatus} from './scan-status'
import {SkeletonReveal} from './skeleton-reveal'
import {Summary} from './summary'

interface Outcome {
  title: string
  body: string
}

interface AppState {
  data: ScanData
  live: boolean
  settled: boolean
  selection: Selection
  progress: CleanupProgress | null
  cleanable: Set<string>
}

const AppContext = createContext<AppState | null>(null)

export function useApp() {
  const state = use(AppContext)
  if (!state) throw new Error('useApp needs the app shell')
  return state
}

const TABS = ['cleanup', 'storage', 'insights'] as const
type Tab = (typeof TABS)[number]
const PANEL: Record<Tab, string> = {cleanup: 'flex min-h-0 flex-col', storage: 'min-h-0 overflow-auto', insights: 'min-h-0 overflow-auto'}

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

export function Streamed({children}: {children: ReactNode}) {
  const {live, settled} = useApp()
  return live ? <SkeletonReveal ready={settled}>{children}</SkeletonReveal> : children
}

function Status({items, progress, lost}: {items: number; progress: CleanupProgress | null; lost: boolean}) {
  if (!progress) return <p className="truncate text-sm leading-5 text-muted-foreground">{items} items found · nothing is deleted until you approve</p>
  return (
    <p className="truncate text-sm leading-5 font-medium text-foreground tabular-nums">
      <BarText progress={progress} lost={lost} />
    </p>
  )
}

function Header({items, progress, lost, onDetails, detailsRef}: {items: number; progress: CleanupProgress | null; lost: boolean; onDetails: () => void; detailsRef: RefObject<HTMLButtonElement | null>}) {
  return (
    <header className="relative flex items-center gap-4 border-b px-7 py-4">
      <div className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
        <HardDrive className="size-4" />
      </div>
      <div className="flex min-w-0 grow flex-col">
        <h1 className="text-[15px] font-semibold">Disk Clean</h1>
        <Status items={items} progress={progress} lost={lost} />
      </div>
      {progress && <DetailsButton ref={detailsRef} onClick={onDetails} />}
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

interface Checked {
  plan: Plan
  items: readonly Item[]
}

function useDecisions(token: string, selection: Selection, data: ScanData, approved: boolean) {
  const navigate = useNavigate()
  const [checked, setChecked] = useState<Checked | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [done, setDone] = useState<Outcome | null>(null)
  const [film, setFilm] = useState<FilmPlan | null>(() => (approved ? planOf(data, selection) : null))
  const [error, setError] = useState('')

  const run = (task: Promise<unknown>, onDone: () => void) =>
    task.then(onDone).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))

  const check = () => {
    const items = selection.selected
    setPreviewing(true)
    setError('')
    run(preview(token, items).then(plan => setChecked({plan, items})), () => {}).finally(() => setPreviewing(false))
  }
  const openConfirm = () => navigate({to: '/cleanup/confirm', search: true})
  const approve = () => {
    if (selection.selected.length === 0) return
    run(decide(token, 'approve', selection.selected), () => setFilm(planOf(data, selection)))
  }
  const cancel = () => run(decide(token, 'cancel', []), () => setDone({title: 'Cancelled', body: 'Nothing was deleted. You can close this tab.'}))
  const plan = checked?.items === selection.selected ? checked.plan : null

  return {plan, previewing, done, film, error, check, openConfirm, approve, cancel}
}

function isLocked(scan: Scan) {
  return !scan.done || scan.error !== ''
}

function scanProgressOf(live: boolean, scan: Scan) {
  return {tracking: live || scan.rescans > 0, settled: scan.walked || scan.rescans > 0 || scan.error !== ''}
}

function ScanSummary({live, scan, selection, progress, approved, onRescan}: {live: boolean; scan: Scan; selection: Selection; progress: CleanupProgress | null; approved: boolean; onRescan: () => void}) {
  const {tracking, settled} = scanProgressOf(live, scan)
  const hero = useScanHero(live, scan, selection.exactBytes)
  return (
    <Summary
      data={scan.data}
      selection={selection}
      bytes={progress ? resultBytes(progress) : hero.bytes}
      overlay={hero.overlay}
      counter={tracking && <ScanCounter scan={scan} />}
      status={
        <>
          {tracking && <ScanStatus scan={scan} />}
          <RescanButton scan={scan} approved={approved} onRescan={onRescan} />
        </>
      }
      scanning={live && !settled}
      progress={progress}
    />
  )
}

interface ConfirmProps {
  plan: Plan | null
  home: string
  ready: boolean
  approved: boolean
  onCheck: () => void
  onApprove: () => void
  returnFocus: RefObject<HTMLButtonElement | null>
}

function useRouteOpen(to: '/cleanup/confirm' | '/cleanup/free') {
  return useMatch({from: to, shouldThrow: false, select: () => true}) ?? false
}

function DeleteConfirm({plan, home, ready, approved, onCheck, onApprove, returnFocus}: ConfirmProps) {
  const open = useRouteOpen('/cleanup/confirm')
  const navigate = useNavigate()
  const back = useBack()
  const wanted = open && ready && !plan && !approved
  useEffect(() => {
    if (wanted) onCheck()
  }, [wanted])
  if (open && approved) return <Navigate to="/cleanup" search replace />
  const approve = () => {
    navigate({to: '/cleanup', search: true, replace: true})
    onApprove()
  }
  return (
    <ConfirmDialog
      plan={plan}
      home={home}
      open={open}
      onOpenChange={next => next || back({to: '/cleanup', search: true})}
      onConfirm={approve}
      returnFocus={returnFocus}
    />
  )
}

function FreeConfirm({progress, onFree}: {progress: CleanupProgress | null; onFree: () => void}) {
  const open = useRouteOpen('/cleanup/free')
  const back = useBack()
  const navigate = useNavigate()
  const offer = freeOffer(progress)
  if (open && offer === 'refused') return <Navigate to="/cleanup" search replace />
  if (!progress) return null
  const free = () => {
    navigate({to: '/cleanup', search: true, replace: true})
    onFree()
  }
  return <FreeDialog progress={progress} open={open && offer === 'offered'} onOpenChange={next => next || back({to: '/cleanup', search: true})} onFree={free} />
}

function useHeld(token: string, progress: CleanupProgress | null) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = (action: 'undo' | 'free') => {
    setBusy(true)
    setError('')
    heldAction(token, action)
      .catch((e: unknown) => setError(`${action === 'undo' ? 'Undo' : 'Free'} did not start (${e instanceof Error ? e.message : String(e)}). From the terminal: disk-clean ${action} RUN_DIR`))
      .finally(() => setBusy(false))
  }
  const actions = progress && (
    <HeldActions
      progress={progress}
      busy={busy}
      error={error}
      onUndo={() => send('undo')}
      onFree={() => navigate({to: '/cleanup/free', search: true})}
    />
  )
  return {actions, free: () => send('free')}
}

function useTabSwitch(tab: Tab | undefined) {
  const router = useRouter()
  const hrefs = useRef(new Map<string, string>())
  return (next: string) => {
    if (tab) hrefs.current.set(tab, router.state.location.href)
    router.navigate({href: hrefs.current.get(next) ?? `/${next}`})
  }
}

function TabPanel({tab}: {tab: Tab | undefined}) {
  if (!tab) {
    return (
      <div className="min-h-0 grow overflow-auto">
        <Outlet />
      </div>
    )
  }
  return (
    <TabsContent value={tab} className={PANEL[tab]}>
      <Outlet />
    </TabsContent>
  )
}

export function Shell({loaded}: {loaded: Loaded}) {
  const live = loaded.live === true
  const {scan, rescan} = useScan(loaded)
  const {settled} = scanProgressOf(live, scan)
  const {data} = scan
  const selection = useSelection(data.categories, loaded.approved)
  const {plan, previewing, done, film, error, check, openConfirm, approve, cancel} = useDecisions(loaded.token, selection, data, loaded.approved !== undefined)
  const {progress, lost} = useCleanupProgress(loaded.token, film, loaded.openEvents)
  const held = useHeld(loaded.token, progress)
  const approved = film !== null
  const navigate = useNavigate()
  const tab = useChildMatches({select: matches => TABS.find(t => matches[0]?.routeId === `/${t}`)})
  const switchTab = useTabSwitch(tab)
  const detailsRef = useRef<HTMLButtonElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const openDetails = () => navigate({to: '.', search: prev => ({...prev, overlay: 'progress'})})
  const cleanable = useMemo(
    () => new Set(data.categories.flatMap(c => c.items.filter(i => !i.report).map(i => i.path))),
    [data.categories],
  )
  const itemCount = data.categories.reduce((sum, c) => sum + c.items.length, 0)
  const locked = isLocked(scan)

  if (done) return <Finished {...done} />

  return (
    <AppContext value={{data, live, settled, selection, progress, cleanable}}>
      <Tabs value={tab ?? null} onValueChange={value => switchTab(String(value))} className="flex h-svh flex-col gap-0">
        {progress && <CleanupTracker progress={progress} returnFocus={detailsRef} held={held.actions} />}
        <Header items={itemCount} progress={progress} lost={lost} onDetails={openDetails} detailsRef={detailsRef} />
        <ScanSummary live={live} scan={scan} selection={selection} progress={progress} approved={approved} onRescan={rescan} />
        <Problems scanError={scan.error} error={error} />
        <TabPanel tab={tab} />
        <ActionBar key={scan.rescans} selection={selection} locked={locked} progress={progress} deleteRef={deleteRef} held={held.actions} onCancel={cancel} onDelete={openConfirm} />
        <DeleteConfirm
          plan={plan}
          home={homeOf(data.tree)}
          ready={!locked && !previewing && error === '' && selection.selected.length > 0}
          approved={approved}
          onCheck={check}
          onApprove={approve}
          returnFocus={deleteRef}
        />
        <FreeConfirm progress={progress} onFree={held.free} />
      </Tabs>
    </AppContext>
  )
}

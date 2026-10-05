import {getRouteApi, Link, linkOptions, Outlet, useLinkProps, useNavigate} from '@tanstack/react-router'
import {HardDrive} from 'lucide-react'
import {useRef, useSyncExternalStore, type ReactNode, type RefObject} from 'react'
import {TAB_LINK, TabLinks} from '@/components/ui/tabs'
import {useCommands} from '@/lib/commands'
import {plural} from '@/lib/data'
import {useDb, type Action, type Db, type Link as StreamLink} from '@/lib/db'
import {useShownOnMount} from '@/lib/motion'
import {firstSectionNow, useDecisions, useProgress, useScan, useSelection, type Ending, type Selection} from '@/lib/page-data'
import {heroBytes, type CleanupProgress, type Phase} from '@/lib/progress'
import {useDisk, usePending, useSession} from '@/lib/views'
import {ActionBar, DeleteReady, deleteState, useOpenConfirm} from './action-bar'
import {BarText, CleanupCounter, CleanupStatus, CleanupTracker, DetailsButton, ProgressTrack, TrashActions, trashOffer} from './cleanup-progress'
import {CommandMenu} from './command-menu'
import {RequestError} from './request-error'
import {ScanCounter, useScanHero} from './scan-hero'
import {RescanButton, ScanStatus} from './scan-status'
import {Summary} from './summary'

function Finished({title, body}: Ending) {
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

function ScanProblem({error}: {error: string}) {
  if (!error) return null
  return (
    <div role="alert" className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-7">
      <p className="pointer-events-auto max-w-2xl rounded-lg border border-destructive/40 bg-card px-4 py-2 text-xs text-destructive shadow-md">
        The scan failed: {error}. Nothing can be approved.
      </p>
    </div>
  )
}

const SCAN_LINK: Record<StreamLink, string> = {
  live: '',
  reconnecting: 'Reconnecting to disk-clean…',
  lost: 'Lost contact with disk-clean: reload to reconnect',
}

function Status({items, progress, phase, link}: {items: number; progress: CleanupProgress | null; phase: Phase; link: StreamLink}) {
  if (progress) {
    return (
      <p className="truncate text-sm leading-5 font-medium text-foreground tabular-nums">
        <BarText progress={progress} phase={phase} />
      </p>
    )
  }
  if (link !== 'live') return <p className="truncate text-sm leading-5 font-medium text-red-300">{SCAN_LINK[link]}</p>
  return <p className="truncate text-sm leading-5 text-muted-foreground">{plural(items, 'item', 'items')} found · nothing is deleted until you approve</p>
}

const TABS = [
  {id: '/_tabs/cleanup', label: 'Cleanup', link: linkOptions({to: '/cleanup'})},
  {id: '/_tabs/storage', label: 'Storage', link: linkOptions({to: '/storage'})},
  {id: '/_tabs/insights', label: 'Insights', link: linkOptions({to: '/insights'})},
  {id: '/_tabs/trash', label: 'Trash', link: linkOptions({to: '/trash'})},
] as const

const root = getRouteApi('__root__')

function TabLink({tab}: {tab: (typeof TABS)[number]}) {
  const tabs = root.useRouteContext({select: context => context.tabs})
  const last = useSyncExternalStore(tabs.subscribe, () => tabs.placeOf(tab.id)) ?? tab.link
  const active = 'data-status' in useLinkProps({...tab.link, activeOptions: {includeSearch: false}})
  return (
    <Link {...last} role="tab" aria-selected={active} className={TAB_LINK}>
      {tab.label}
    </Link>
  )
}

function Tabs() {
  const tabs = root.useRouteContext({select: context => context.tabs})
  const navigate = useNavigate()
  useCommands(TABS.map(tab => ({id: tab.id, name: `Go to ${tab.label}`, group: 'Go to', enabled: true, run: () => navigate(tabs.placeOf(tab.id) ?? tab.link)})))
  return (
    <TabLinks label="Views">
      {TABS.map(tab => (
        <TabLink key={tab.id} tab={tab} />
      ))}
    </TabLinks>
  )
}

function Header({
  items,
  progress,
  phase,
  link,
  onDetails,
  detailsRef,
}: {
  items: number
  progress: CleanupProgress | null
  phase: Phase
  link: StreamLink
  onDetails: () => void
  detailsRef: RefObject<HTMLButtonElement | null>
}) {
  return (
    <header className="relative flex items-center gap-4 border-b px-7 py-4">
      <div className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
        <HardDrive className="size-4" />
      </div>
      <div className="flex min-w-0 grow flex-col">
        <h1 className="text-[15px] font-semibold">Disk Clean</h1>
        <Status items={items} progress={progress} phase={phase} link={link} />
      </div>
      {progress && <DetailsButton ref={detailsRef} onClick={onDetails} />}
      <Tabs />
      {progress && <ProgressTrack progress={progress} phase={phase} />}
    </header>
  )
}

function StatusSlot({scan, progress, phase}: {scan: ReturnType<typeof useScan>; progress: CleanupProgress | null; phase: Phase}) {
  if (progress) return <span className="w-56 shrink-0"><CleanupStatus progress={progress} phase={phase} /></span>
  return scan.tracking && <span className="w-56 shrink-0"><ScanStatus scan={scan.scan} /></span>
}

function ScanSummary({db, scan, selection, progress, phase, approved}: {db: Db; scan: ReturnType<typeof useScan>; selection: Selection; progress: CleanupProgress | null; phase: Phase; approved: boolean}) {
  const hero = useScanHero(phase === 'scanning' && scan.live, scan.scan, selection.exactBytes)
  const disk = useDisk(db)
  return (
    <Summary
      disk={disk}
      selection={selection}
      bytes={progress ? heroBytes(phase, progress) : hero.bytes}
      overlay={hero.overlay}
      counter={scan.tracking && (progress ? <CleanupCounter progress={progress} phase={phase} /> : <ScanCounter scan={scan.scan} />)}
      status={
        <>
          <StatusSlot scan={scan} progress={progress} phase={phase} />
          <RescanButton scan={scan.scan} approved={approved} onRescan={scan.rescan} />
          <RequestError db={db} action="rescan" onRetry={scan.rescan} />
        </>
      }
      scanning={phase === 'scanning' && scan.live && !scan.settled}
      phase={phase}
      progress={progress}
    />
  )
}

const TRASH_ACTIONS: readonly Action[] = ['undo', 'empty']

function useTrashActions(db: Db, progress: CleanupProgress | null, phase: Phase, trash: (action: 'undo' | 'empty', ids: readonly string[]) => void, sectionOf: (params: {section?: string}) => string) {
  const navigate = useNavigate()
  const busy = usePending(db, TRASH_ACTIONS)
  const offer = progress && trashOffer(progress, phase, busy)
  const ready = offer !== null && offer.offered && !offer.waiting
  const undo = () => trash('undo', progress?.inTrash.ids ?? [])
  const empty = () => navigate({to: '/cleanup/$section/empty', params: prev => ({section: sectionOf(prev)}), search: true})
  useCommands([
    {id: 'undo-cleanup', name: 'Undo this cleanup', group: 'Clean up', enabled: ready, run: undo},
    {id: 'empty-cleanup', name: 'Empty these from Trash…', group: 'Clean up', enabled: ready, run: empty},
  ])
  if (!progress) return null
  return (
    <TrashActions
      progress={progress}
      phase={phase}
      busy={busy}
      error={
        <>
          <RequestError db={db} action="undo" onRetry={undo} />
          <RequestError db={db} action="empty" onRetry={() => trash('empty', progress.inTrash.ids)} />
        </>
      }
      onUndo={undo}
      onEmpty={empty}
    />
  )
}

function Tracker({progress, ...props}: {db: Db; progress: CleanupProgress | null; phase: Phase; returnFocus: RefObject<HTMLButtonElement | null>; actions: ReactNode}) {
  return progress && <CleanupTracker progress={progress} {...props} />
}

function Failures({db, onApprove, onCancel}: {db: Db; onApprove: () => void; onCancel: () => void}) {
  return (
    <>
      <RequestError db={db} action="approve" onRetry={onApprove} />
      <RequestError db={db} action="cancel" onRetry={onCancel} />
    </>
  )
}

export function Shell() {
  const db = useDb()
  const scan = useScan()
  const selection = useSelection()
  const {progress, phase} = useProgress()
  const decisions = useDecisions()
  const session = useSession(db)
  const navigate = useNavigate()
  const detailsRef = useRef<HTMLButtonElement>(null)
  const sectionOf = (params: {section?: string}) => params.section ?? firstSectionNow(db) ?? ''
  const actions = useTrashActions(db, progress, phase, decisions.trash, sectionOf)
  const openConfirm = useOpenConfirm()
  const onDetails = () => navigate({to: '.', search: prev => ({...prev, overlay: 'progress'})})
  useCommands([{id: 'details', name: 'Show cleanup details', group: 'Clean up', enabled: progress !== null, run: onDetails}])

  if (decisions.done) return <Finished {...decisions.done} />

  return (
    <div className="flex h-svh flex-col">
      <Tracker db={db} progress={progress} phase={phase} returnFocus={detailsRef} actions={actions} />
      <Header items={selection.count} progress={progress} phase={phase} link={session.scanLink} onDetails={onDetails} detailsRef={detailsRef} />
      <ScanSummary db={db} scan={scan} selection={selection} progress={progress} phase={phase} approved={decisions.approved} />
      <div className="relative flex min-h-0 flex-1 flex-col text-sm">
        <DeleteReady value={deleteState(selection, scan.scan).ready && !progress}>
          <Outlet />
        </DeleteReady>
        <ScanProblem error={scan.scan.error} />
      </div>
      <ActionBar
        key={scan.scan.rescans}
        selection={selection}
        scan={scan.scan}
        progress={progress}
        phase={phase}
        actions={actions}
        failure={<Failures db={db} onApprove={decisions.retry} onCancel={decisions.cancel} />}
        onCancel={decisions.cancel}
        onDelete={openConfirm}
      />
      <CommandMenu />
    </div>
  )
}

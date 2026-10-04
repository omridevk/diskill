import {getRouteApi, Link, linkOptions, Outlet, useLinkProps, useNavigate} from '@tanstack/react-router'
import {HardDrive} from 'lucide-react'
import {useRef, useSyncExternalStore, type ReactNode, type RefObject} from 'react'
import {TAB_LINK, TabLinks} from '@/components/ui/tabs'
import {plural} from '@/lib/data'
import {useDb, type Action, type Db, type Link as StreamLink} from '@/lib/db'
import {useShownOnMount} from '@/lib/motion'
import {firstSectionNow, useDecisions, useProgress, useScan, useSelection, type Ending, type Selection} from '@/lib/page-data'
import {resultBytes, type CleanupProgress} from '@/lib/progress'
import {useDisk, usePending, useSession} from '@/lib/views'
import {ActionBar} from './action-bar'
import {BarText, CleanupTracker, DetailsButton, HeldActions, ProgressTrack} from './cleanup-progress'
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
  return <div className="border-b bg-red-500/10 px-7 py-2 text-xs text-red-300">The scan failed: {error}. Nothing can be approved.</div>
}

const SCAN_LINK: Record<StreamLink, string> = {
  live: '',
  reconnecting: 'Reconnecting to disk-clean…',
  lost: 'Lost contact with disk-clean: reload to reconnect',
}

function Status({items, progress, link}: {items: number; progress: CleanupProgress | null; link: StreamLink}) {
  if (progress) {
    return (
      <p className="truncate text-sm leading-5 font-medium text-foreground tabular-nums">
        <BarText progress={progress} />
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
  return (
    <TabLinks label="Views">
      {TABS.map(tab => (
        <TabLink key={tab.id} tab={tab} />
      ))}
    </TabLinks>
  )
}

function Header({items, progress, link, onDetails, detailsRef}: {items: number; progress: CleanupProgress | null; link: StreamLink; onDetails: () => void; detailsRef: RefObject<HTMLButtonElement | null>}) {
  return (
    <header className="relative flex items-center gap-4 border-b px-7 py-4">
      <div className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
        <HardDrive className="size-4" />
      </div>
      <div className="flex min-w-0 grow flex-col">
        <h1 className="text-[15px] font-semibold">Disk Clean</h1>
        <Status items={items} progress={progress} link={link} />
      </div>
      {progress && <DetailsButton ref={detailsRef} onClick={onDetails} />}
      <Tabs />
      {progress && <ProgressTrack progress={progress} />}
    </header>
  )
}

function ScanSummary({db, scan, selection, progress, approved}: {db: Db; scan: ReturnType<typeof useScan>; selection: Selection; progress: CleanupProgress | null; approved: boolean}) {
  const hero = useScanHero(scan.live, scan.scan, selection.exactBytes)
  const disk = useDisk(db)
  return (
    <Summary
      disk={disk}
      selection={selection}
      bytes={progress ? resultBytes(progress) : hero.bytes}
      overlay={hero.overlay}
      counter={scan.tracking && <ScanCounter scan={scan.scan} />}
      status={
        <>
          {scan.tracking && <ScanStatus scan={scan.scan} />}
          <RescanButton scan={scan.scan} approved={approved} onRescan={scan.rescan} />
          <RequestError db={db} action="rescan" onRetry={scan.rescan} />
        </>
      }
      scanning={scan.live && !scan.settled}
      progress={progress}
    />
  )
}

const HELD: readonly Action[] = ['undo', 'free']

function useHeld(db: Db, progress: CleanupProgress | null, held: (action: 'undo' | 'free') => void, sectionOf: (params: {section?: string}) => string) {
  const navigate = useNavigate()
  const busy = usePending(db, HELD)
  return (
    progress && (
      <HeldActions
        progress={progress}
        busy={busy}
        error={
          <>
            <RequestError db={db} action="undo" onRetry={() => held('undo')} />
            <RequestError db={db} action="free" onRetry={() => held('free')} />
          </>
        }
        onUndo={() => held('undo')}
        onFree={() => navigate({to: '/cleanup/$section/free', params: prev => ({section: sectionOf(prev)}), search: true})}
      />
    )
  )
}

function Tracker({progress, ...props}: {db: Db; progress: CleanupProgress | null; returnFocus: RefObject<HTMLButtonElement | null>; held: ReactNode}) {
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
  const {progress} = useProgress()
  const decisions = useDecisions()
  const session = useSession(db)
  const navigate = useNavigate()
  const detailsRef = useRef<HTMLButtonElement>(null)
  const sectionOf = (params: {section?: string}) => params.section ?? firstSectionNow(db) ?? ''
  const held = useHeld(db, progress, decisions.held, sectionOf)

  if (decisions.done) return <Finished {...decisions.done} />

  return (
    <div className="flex h-svh flex-col">
      <Tracker db={db} progress={progress} returnFocus={detailsRef} held={held} />
      <Header items={selection.count} progress={progress} link={session.scanLink} onDetails={() => navigate({to: '.', search: prev => ({...prev, overlay: 'progress'})})} detailsRef={detailsRef} />
      <ScanSummary db={db} scan={scan} selection={selection} progress={progress} approved={decisions.approved} />
      <ScanProblem error={scan.scan.error} />
      <div className="flex min-h-0 flex-1 flex-col text-sm">
        <Outlet />
      </div>
      <ActionBar
        key={scan.scan.rescans}
        selection={selection}
        scan={scan.scan}
        progress={progress}
        held={held}
        failure={<Failures db={db} onApprove={decisions.retry} onCancel={decisions.cancel} />}
        onCancel={decisions.cancel}
        onDelete={() => navigate({to: '/cleanup/$section/confirm', params: prev => ({section: sectionOf(prev)}), search: true})}
      />
    </div>
  )
}

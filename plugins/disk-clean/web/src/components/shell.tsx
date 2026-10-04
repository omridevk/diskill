import {Link, Outlet, useNavigate} from '@tanstack/react-router'
import {HardDrive} from 'lucide-react'
import {useRef, type RefObject} from 'react'
import {TAB_LINK, TabLinks} from '@/components/ui/tabs'
import {resultBytes, type CleanupProgress} from '@/lib/cleanup'
import type {Scan} from '@/lib/scan'
import {useShownOnMount} from '@/lib/motion'
import {useDecisions, useProgress, useScan, useSelection, type Ending} from '@/lib/page-data'
import type {Selection} from '@/lib/selection'
import {ActionBar} from './action-bar'
import {BarText, CleanupTracker, DetailsButton, HeldActions, ProgressTrack} from './cleanup-progress'
import {ScanCounter, useScanHero} from './scan-hero'
import {RescanButton, ScanStatus} from './scan-status'
import {Summary} from './summary'

const TAB = {role: 'tab', className: TAB_LINK, activeOptions: {includeSearch: false}, activeProps: {'aria-selected': true}, inactiveProps: {'aria-selected': false}} as const

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

function Status({items, progress, lost}: {items: number; progress: CleanupProgress | null; lost: boolean}) {
  if (!progress) return <p className="truncate text-sm leading-5 text-muted-foreground">{items} items found · nothing is deleted until you approve</p>
  return (
    <p className="truncate text-sm leading-5 font-medium text-foreground tabular-nums">
      <BarText progress={progress} lost={lost} />
    </p>
  )
}

function Tabs() {
  return (
    <TabLinks label="Views">
      <Link to="/cleanup" {...TAB}>
        Cleanup
      </Link>
      <Link to="/storage/$" params={{_splat: ''}} {...TAB}>
        Storage
      </Link>
      <Link to="/insights" {...TAB}>
        Insights
      </Link>
    </TabLinks>
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
      <Tabs />
      {progress && <ProgressTrack progress={progress} />}
    </header>
  )
}

function ScanSummary({scan, selection, progress, approved}: {scan: ReturnType<typeof useScan>; selection: Selection; progress: CleanupProgress | null; approved: boolean}) {
  const hero = useScanHero(scan.live, scan.scan, selection.exactBytes)
  return (
    <Summary
      data={scan.scan.data}
      selection={selection}
      bytes={progress ? resultBytes(progress) : hero.bytes}
      overlay={hero.overlay}
      counter={scan.tracking && <ScanCounter scan={scan.scan} />}
      status={
        <>
          {scan.tracking && <ScanStatus scan={scan.scan} />}
          <RescanButton scan={scan.scan} approved={approved} onRescan={scan.rescan} />
        </>
      }
      scanning={scan.live && !scan.settled}
      progress={progress}
    />
  )
}

function isLocked(scan: Scan) {
  return !scan.done || scan.error !== ''
}

export function Shell() {
  const scan = useScan()
  const selection = useSelection()
  const {progress, lost} = useProgress()
  const decisions = useDecisions()
  const navigate = useNavigate()
  const detailsRef = useRef<HTMLButtonElement>(null)
  const {data} = scan.scan
  const itemCount = data.categories.reduce((sum, c) => sum + c.items.length, 0)
  const held = progress && (
    <HeldActions
      progress={progress}
      busy={decisions.heldBusy}
      error={decisions.heldError}
      onUndo={() => decisions.held('undo')}
      onFree={() => navigate({to: '/cleanup/free', search: true})}
    />
  )

  if (decisions.done) return <Finished {...decisions.done} />

  return (
    <div className="flex h-svh flex-col">
      {progress && <CleanupTracker progress={progress} returnFocus={detailsRef} held={held} />}
      <Header items={itemCount} progress={progress} lost={lost} onDetails={() => navigate({to: '.', search: prev => ({...prev, overlay: 'progress'})})} detailsRef={detailsRef} />
      <ScanSummary scan={scan} selection={selection} progress={progress} approved={decisions.approved} />
      <Problems scanError={scan.scan.error} error={decisions.error} />
      <div className="flex min-h-0 flex-1 flex-col text-sm">
        <Outlet />
      </div>
      <ActionBar
        key={scan.scan.rescans}
        selection={selection}
        locked={isLocked(scan.scan)}
        progress={progress}
        held={held}
        onCancel={decisions.cancel}
        onDelete={() => navigate({to: '/cleanup/confirm', search: true})}
      />
    </div>
  )
}

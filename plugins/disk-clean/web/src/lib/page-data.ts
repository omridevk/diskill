import {getRouteApi, useNavigate} from '@tanstack/react-router'
import {functionalUpdate, type RowSelectionState, type Updater} from '@tanstack/react-table'
import {createContext, use, useMemo, useState} from 'react'
import {decide, heldAction, preview, type Plan} from './api'
import {filmPlan, freeOffer, useCleanupProgress, type FilmPlan, type FreeOffer} from './cleanup'
import type {Loaded, ScanData} from './data'
import {useScanStream} from './live'
import {startScan, type Scan} from './scan'
import {NO_PICKS, picksOf, selectionOf, type Picked, type Picks, type Selection} from './selection'

export interface Ending {
  title: string
  body: string
}

interface Seen {
  scan: Scan
  approved: boolean
  offer: FreeOffer
}

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isScanned = (scan: Scan) => scan.done && scan.error === ''

function planOf(data: ScanData, picked: Picked) {
  return filmPlan(data.categories, picked.selected, picked.exactBytes, data.total)
}

function startFilm(loaded: Loaded) {
  return loaded.approved ? planOf(loaded.data, selectionOf(loaded.data.categories, NO_PICKS, loaded.approved)) : null
}

export function createPage(loaded: Loaded) {
  const approved = startFilm(loaded) !== null
  const seen: Seen = {scan: startScan(loaded), approved, offer: approved ? 'waiting' : 'refused'}
  return {loaded, seen}
}

export type Page = ReturnType<typeof createPage>

function selectedFor(page: Page, picks: Picks) {
  return selectionOf(page.seen.scan.data.categories, picks, page.loaded.approved).selected
}

export function canConfirm(page: Page, picks: Picks) {
  return isScanned(page.seen.scan) && !page.seen.approved && selectedFor(page, picks).length > 0
}

export function planFor(page: Page, picks: Picks): Promise<Plan> {
  return preview(page.loaded.token, selectedFor(page, picks))
}

function useDecisionState(loaded: Loaded, data: ScanData) {
  const [film, setFilm] = useState<FilmPlan | null>(() => startFilm(loaded))
  const [done, setDone] = useState<Ending | null>(null)
  const [error, setError] = useState('')
  const fail = (e: unknown) => setError(messageOf(e))
  const approve = (picks: Picks) => {
    const picked = selectionOf(data.categories, picks, loaded.approved)
    if (picked.selected.length === 0) return
    setError('')
    decide(loaded.token, 'approve', picked.selected).then(() => setFilm(planOf(data, picked)), fail)
  }
  const cancel = () => decide(loaded.token, 'cancel', []).then(() => setDone({title: 'Cancelled', body: 'Nothing was deleted. You can close this tab.'}), fail)
  return {film, done, error, approve, cancel}
}

function useHeldState(token: string) {
  const [heldBusy, setBusy] = useState(false)
  const [heldError, setError] = useState('')
  const held = (action: 'undo' | 'free') => {
    setBusy(true)
    setError('')
    heldAction(token, action)
      .catch((e: unknown) => setError(`${action === 'undo' ? 'Undo' : 'Free'} did not start (${messageOf(e)}). From the terminal: disk-clean ${action} RUN_DIR`))
      .finally(() => setBusy(false))
  }
  return {heldBusy, heldError, held}
}

function settledOf(live: boolean, scan: Scan) {
  return {tracking: live || scan.rescans > 0, settled: scan.walked || scan.rescans > 0 || scan.error !== ''}
}

export function usePageState(page: Page) {
  const {loaded} = page
  const live = loaded.live === true
  const {scan, rescan} = useScanStream(loaded)
  const decisions = useDecisionState(loaded, scan.data)
  const {progress, lost} = useCleanupProgress(loaded.token, decisions.film, loaded.openEvents)
  const held = useHeldState(loaded.token)
  page.seen = {scan, approved: decisions.film !== null, offer: freeOffer(progress)}
  return {loaded, live, scan, rescan, ...settledOf(live, scan), ...decisions, progress, lost, ...held}
}

type PageState = ReturnType<typeof usePageState>

export const PageContext = createContext<PageState | null>(null)

function usePage() {
  const state = use(PageContext)
  if (!state) throw new Error('page data is provided by the root route')
  return state
}

export function useScan() {
  const {scan, live, rescan, tracking, settled} = usePage()
  return {scan, live, rescan, tracking, settled}
}

export function useScanData() {
  return usePage().scan.data
}

export function useStreaming() {
  const {live, settled} = usePage()
  return {live, settled}
}

export function useCleanable() {
  const {categories} = useScanData()
  return useMemo(() => new Set(categories.flatMap(c => c.items.filter(i => !i.report).map(i => i.path))), [categories])
}

const root = getRouteApi('__root__')

function usePicks(): Picks {
  const add = root.useSearch({select: search => search.add})
  const drop = root.useSearch({select: search => search.drop})
  return useMemo(() => ({add, drop}), [add, drop])
}

export function useSelection(): Selection {
  const {loaded, scan} = usePage()
  const {categories} = scan.data
  const picks = usePicks()
  const navigate = useNavigate()
  const picked = selectionOf(categories, picks, loaded.approved)
  return useMemo(() => {
    const setRowSelection = (update: Updater<RowSelectionState>) =>
      navigate({
        to: '.',
        search: prev => {
          const current = selectionOf(categories, {add: prev.add ?? '', drop: prev.drop ?? ''}, loaded.approved)
          return {...prev, ...picksOf(categories, functionalUpdate(update, current.rowSelection))}
        },
        replace: true,
      })
    const reset = () => navigate({to: '.', search: prev => ({...prev, ...NO_PICKS}), replace: true})
    return {...picked, setRowSelection, reset}
  }, [picked, categories, navigate, loaded.approved])
}

export function useProgress() {
  const {progress, lost} = usePage()
  return {progress, lost}
}

export function useDecisions() {
  const {film, done, error, approve, cancel, heldBusy, heldError, held} = usePage()
  return {approved: film !== null, done, error, approve, cancel, heldBusy, heldError, held}
}


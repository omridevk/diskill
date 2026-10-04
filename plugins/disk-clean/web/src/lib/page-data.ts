import {queryCollectionOptions} from '@tanstack/query-db-collection'
import {createCollection, useLiveQuery} from '@tanstack/react-db'
import {getRouteApi, useNavigate} from '@tanstack/react-router'
import {functionalUpdate, type RowSelectionState, type Updater} from '@tanstack/react-table'
import {useCallback, useMemo} from 'react'
import {approve as approveItems, askHeld, cancel as cancelRun, restartScan} from './actions'
import {preview, type Plan} from './api'
import {firstSection, type Category} from './data'
import {useDb, type Db} from './db'
import {useCleanupProgress} from './progress'
import type {Entry, Nest, ScanState} from './scan-feed'
import {NO_PICKS, picksOf, rowSelectionOf, type Picks} from './selection'
import {categoriesOf, useScanState, useSession, useVersion} from './views'

export interface Ending {
  title: string
  body: string
}

export interface Selection {
  count: number
  nests: Nest[]
  rowSelection: RowSelectionState
  setRowSelection: (update: Updater<RowSelectionState>) => void
  isOn: (item: {path: string}) => boolean
  reset: () => void
  selected: Entry[]
  exactBytes: number
  apparentBytes: number
  risky: number
  sections: number
}

const CANCELLED: Ending = {title: 'Cancelled', body: 'Nothing was deleted. You can close this tab.'}

interface Grouped {
  items: number
  sections: number
  categories: Category[]
}

const grouped = new WeakMap<Db, Grouped>()

function categoriesNow(db: Db) {
  const items = db.scan.items.version()
  const sections = db.scan.sections.version()
  const known = grouped.get(db)
  if (known?.items === items && known.sections === sections) return known.categories
  const categories = categoriesOf([...db.scan.sections.synced.values()], [...db.scan.items.synced.values()])
  grouped.set(db, {items, sections, categories})
  return categories
}

interface Decoded extends Picks {
  categories: readonly Category[]
  on: RowSelectionState
}

const decoded = new WeakMap<Db, Decoded>()

function approvedSelection(approved: readonly string[]): RowSelectionState {
  return Object.fromEntries(approved.map(path => [path, true] as const))
}

function rowSelectionNow(db: Db, picks: Picks): RowSelectionState {
  const categories = categoriesNow(db)
  const known = decoded.get(db)
  if (known?.categories === categories && known.add === picks.add && known.drop === picks.drop) return known.on
  const on = db.loaded.approved ? approvedSelection(db.loaded.approved) : rowSelectionOf(categories, picks)
  decoded.set(db, {categories, ...picks, on})
  return on
}

function shadowedOf(nests: readonly Nest[], on: RowSelectionState) {
  return new Set(nests.filter(n => on[n.outer] === true && on[n.inner] === true).map(n => n.inner))
}

function totalsOf(selected: readonly Entry[], shadowed: ReadonlySet<string>) {
  let exactBytes = 0
  let apparentBytes = 0
  let risky = 0
  const sections = new Set<string>()
  for (const entry of selected) {
    sections.add(entry.section)
    if (entry.risk === 'review') risky++
    if (shadowed.has(entry.path)) continue
    if (entry.exact) exactBytes += entry.bytes
    else apparentBytes += entry.bytes
  }
  return {exactBytes, apparentBytes, risky, sections: sections.size}
}

function selectedOf(db: Db, on: RowSelectionState) {
  const selected: Entry[] = []
  for (const path of Object.keys(on)) {
    const entry = on[path] === true ? db.scan.items.synced.get(path) : undefined
    if (entry && !entry.report) selected.push(entry)
  }
  return selected
}

type Derived = ReturnType<typeof totalsOf> & {selected: Entry[]; nests: Nest[]}

const derivations = new WeakMap<RowSelectionState, {nests: number; derived: Derived}>()

function derivedOf(db: Db, on: RowSelectionState): Derived {
  const nestsVersion = db.scan.nests.version()
  const known = derivations.get(on)
  if (known?.nests === nestsVersion) return known.derived
  const nests = [...db.scan.nests.synced.values()]
  const selected = selectedOf(db, on)
  const derived = {selected, nests, ...totalsOf(selected, shadowedOf(nests, on))}
  derivations.set(on, {nests: nestsVersion, derived})
  return derived
}

function selectedNow(db: Db, picks: Picks) {
  return derivedOf(db, rowSelectionNow(db, picks)).selected
}

function scanNow(db: Db) {
  return db.scan.scan.synced.get('scan')
}

export function firstSectionNow(db: Db) {
  return firstSection(categoriesNow(db))
}

export function canConfirm(db: Db, picks: Picks) {
  const scan = scanNow(db)
  const approved = db.session.synced.get('session')?.approved ?? false
  return scan !== undefined && scan.done && scan.error === '' && !approved && selectedNow(db, picks).length > 0
}

export function hasSection(db: Db, section: string) {
  return !scanNow(db)?.done || db.scan.sections.synced.has(section)
}

export function isApproved(db: Db) {
  return db.session.synced.get('session')?.approved ?? false
}

interface PreviewRow extends Plan {
  id: 'plan'
}

function previewCollection(db: Db, key: string, picks: Picks) {
  return createCollection(
    queryCollectionOptions({
      queryKey: ['preview', key],
      queryFn: async (): Promise<PreviewRow[]> => [{...(await preview(db.loaded.token, selectedNow(db, picks))), id: 'plan'}],
      queryClient: db.queryClient,
      getKey: row => row.id,
      startSync: false,
    }),
  )
}

type Preview = ReturnType<typeof previewCollection>

const previews = new WeakMap<Db, Map<string, Preview>>()

export function previewOf(db: Db, picks: Picks) {
  const key = `${scanNow(db)?.rescans ?? 0}|${picks.add}|${picks.drop}`
  const mine = previews.get(db) ?? new Map<string, Preview>()
  previews.set(db, mine)
  const known = mine.get(key)
  if (known) return known
  const collection = previewCollection(db, key, picks)
  mine.set(key, collection)
  return collection
}

export async function loadPreview(db: Db, picks: Picks) {
  const collection = previewOf(db, picks)
  if (collection.status === 'error') await collection.utils.refetch({throwOnError: true})
  else await collection.preload()
}

const root = getRouteApi('__root__')

function usePicks(): Picks {
  const add = root.useSearch({select: search => search.add})
  const drop = root.useSearch({select: search => search.drop})
  return useMemo(() => ({add, drop}), [add, drop])
}

function useCategoriesNow(db: Db) {
  useVersion(db.scan.items.collection)
  useVersion(db.scan.sections.collection)
  useVersion(db.scan.nests.collection)
  return categoriesNow(db)
}

export function useSelection(): Selection {
  const db = useDb()
  const picks = usePicks()
  const navigate = useNavigate()
  const categories = useCategoriesNow(db)
  const on = rowSelectionNow(db, picks)
  const derived = derivedOf(db, on)
  const setRowSelection = useCallback(
    (update: Updater<RowSelectionState>) =>
      navigate({
        to: '.',
        search: prev => {
          const current = rowSelectionNow(db, {add: prev.add ?? '', drop: prev.drop ?? ''})
          return {...prev, ...picksOf(categoriesNow(db), functionalUpdate(update, current))}
        },
        replace: true,
      }),
    [db, navigate],
  )
  const reset = useCallback(() => navigate({to: '.', search: prev => ({...prev, ...NO_PICKS}), replace: true}), [navigate])
  const count = categories.reduce((sum, c) => sum + c.items.length, 0)
  return useMemo(
    () => ({count, rowSelection: on, setRowSelection, isOn: item => on[item.path] === true, reset, ...derived}),
    [count, on, setRowSelection, reset, derived],
  )
}

function settledOf(live: boolean, scan: ScanState) {
  return {tracking: live || scan.rescans > 0, settled: scan.walked || scan.rescans > 0 || scan.error !== ''}
}

export function useScan() {
  const db = useDb()
  const scan = useScanState(db)
  const live = db.loaded.live === true
  const rescan = useCallback(() => void restartScan(db), [db])
  return {scan, live, rescan, ...settledOf(live, scan)}
}

export function useHome() {
  return useDb().loaded.home
}

export function useStreaming() {
  const {live, settled} = useScan()
  return {live, settled}
}

export function useProgress() {
  return {progress: useCleanupProgress(useDb())}
}

export function useDecisions() {
  const db = useDb()
  const session = useSession(db)
  const picks = usePicks()
  const approve = (picks: Picks) => {
    const on = rowSelectionNow(db, picks)
    const {selected, exactBytes} = derivedOf(db, on)
    if (selected.length === 0) return
    void approveItems(db, selected, exactBytes)
  }
  const cancel = () => void cancelRun(db)
  const held = (action: 'undo' | 'free') => void askHeld(db, action)
  return {approved: session.approved, done: session.cancelled ? CANCELLED : null, approve, retry: () => approve(picks), cancel, held}
}

export function useConnection() {
  useLiveQuery(useDb().connection)
}

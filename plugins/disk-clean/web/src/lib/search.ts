import type {SearchSchemaInput} from '@tanstack/react-router'
import type {Risk} from './data'

export type View = 'list' | 'cards'
export type Sort = 'size-desc' | 'size-asc' | 'name-asc' | 'age-desc' | 'age-asc'
export type LogFilter = 'all' | 'removed' | 'problems' | 'commands'
export type Overlay = 'progress' | 'movie'
export type Shape = 'sunburst' | 'treemap'

export const RISKS: Risk[] = ['safe', 'review', 'report']
export const SORTS: Sort[] = ['size-desc', 'size-asc', 'name-asc', 'age-desc', 'age-asc']
export const MIN_SIZES = [0, 100 << 20, 1 << 30, 5 * (1 << 30)]
export const MIN_AGES = [-1, 30, 90, 365]
export const LOG_FILTERS: LogFilter[] = ['all', 'removed', 'problems', 'commands']
const VIEWS: View[] = ['list', 'cards']
const OVERLAYS: Overlay[] = ['progress', 'movie']
const SHAPES: Shape[] = ['sunburst', 'treemap']

export interface RootSearch {
  overlay?: Overlay
  log: LogFilter
  take: number
}

export interface CleanupSearch {
  view: View
  q: string
  risk: Risk[]
  minSize: number
  minAge: number
  sort: Sort
  only: boolean
}

export interface StorageSearch {
  shape: Shape
}

export const ROOT_DEFAULTS = {log: 'all', take: 0} satisfies Omit<RootSearch, 'overlay'>
export const NO_FILTERS = {q: '', risk: [], minSize: 0, minAge: -1, only: false} satisfies Partial<CleanupSearch>
export const CLEANUP_DEFAULTS: CleanupSearch = {...NO_FILTERS, view: 'list', sort: 'size-desc'}
export const STORAGE_DEFAULTS: StorageSearch = {shape: 'sunburst'}

type Raw<T> = {[K in keyof T]?: T[K]} & SearchSchemaInput

function oneOf<T>(options: readonly T[], value: unknown, fallback: T): T {
  return options.find(option => option === value) ?? fallback
}

function textOf(value: unknown) {
  if (typeof value === 'string') return value
  return typeof value === 'number' ? String(value) : ''
}

function countOf(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

export function rootSearch(raw: Raw<RootSearch>): RootSearch {
  const overlay = OVERLAYS.find(o => o === raw.overlay)
  return {...(overlay && {overlay}), log: oneOf(LOG_FILTERS, raw.log, ROOT_DEFAULTS.log), take: countOf(raw.take)}
}

export function cleanupSearch(raw: Raw<CleanupSearch>): CleanupSearch {
  const risk: unknown = raw.risk
  return {
    view: oneOf(VIEWS, raw.view, CLEANUP_DEFAULTS.view),
    q: textOf(raw.q),
    risk: Array.isArray(risk) ? RISKS.filter(r => risk.includes(r)) : [],
    minSize: oneOf(MIN_SIZES, raw.minSize, CLEANUP_DEFAULTS.minSize),
    minAge: oneOf(MIN_AGES, raw.minAge, CLEANUP_DEFAULTS.minAge),
    sort: oneOf(SORTS, raw.sort, CLEANUP_DEFAULTS.sort),
    only: raw.only === true,
  }
}

export function storageSearch(raw: Raw<StorageSearch>): StorageSearch {
  return {shape: oneOf(SHAPES, raw.shape, STORAGE_DEFAULTS.shape)}
}

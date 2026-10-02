export type Risk = 'safe' | 'review' | 'report'

export interface Item {
  path: string
  label: string
  bytes: number
  action: string
  cmd_id: string
  note: string
  age: number | null
  accuracy: string
  preselect: boolean
  report: boolean
}

export interface Category {
  id: string
  title: string
  desc: string
  risk: Risk
  items: Item[]
  bytes: number
}

export interface TreeNode {
  name: string
  path: string
  bytes: number
  children: TreeNode[]
  rest?: boolean
}

export interface Insights {
  generated_at: number
  modified_by_day: {day: string; bytes: number; files: number}[]
  age_by_folder: {buckets: string[]; folders: {path: string; bytes: number[]}[]}
  by_kind: {kind: string; bytes: number; files: number}[]
  largest_files: {path: string; bytes: number; mtime: number}[]
}

export interface ScanData {
  categories: Category[]
  reclaimable: number
  free: number
  total: number
  used: number
  home: number
  snapshots: number
  tree: TreeNode | null
  insights?: Insights | null
}

export interface Loaded {
  data: ScanData
  token: string
}

export async function load(): Promise<Loaded> {
  const text = document.getElementById('disk-clean-data')?.textContent ?? ''
  const token = document.querySelector<HTMLMetaElement>('meta[name="disk-clean-token"]')?.content ?? ''
  if (import.meta.env.DEV && text.trim() === '__DATA__') {
    const response = await fetch('/dev/fixture.json')
    return response.json()
  }
  return {data: JSON.parse(text), token}
}

const UNITS = ['KB', 'MB', 'GB', 'TB']

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  let value = n
  let unit = -1
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${UNITS[unit]}`
}

export const isExact = (item: Item) => item.accuracy === 'exact'

export const RISK_LABEL: Record<Risk, string> = {safe: 'safe', review: 'review', report: 'report only'}

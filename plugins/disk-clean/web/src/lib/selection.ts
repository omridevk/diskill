import type {RowSelectionState} from '@tanstack/react-table'
import type {Category, Item} from './data'

export interface Picks {
  add: string
  drop: string
}

export const NO_PICKS: Picks = {add: '', drop: ''}

const SECTION = '_'
const SEPARATOR = '.'
const SHORT = 8
const FULL = 11
const TOKEN = /^(_[\w-]+|[0-9a-z]{8}|[0-9a-z]{11})$/

const pickable = (item: Item) => !item.report

function cyrb53(text: string) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

const hashes = new Map<string, string>()

function hashOf(path: string) {
  const known = hashes.get(path)
  if (known) return known
  const hash = cyrb53(path).toString(36).padStart(FULL, '0')
  hashes.set(path, hash)
  return hash
}

const tokenIndexes = new WeakMap<readonly Category[], Map<string, string>>()

function tokensOf(categories: readonly Category[]) {
  const known = tokenIndexes.get(categories)
  if (known) return known
  const paths = categories.flatMap(c => c.items.filter(pickable).map(i => i.path))
  const shorts = new Map<string, number>()
  for (const path of paths) {
    const short = hashOf(path).slice(0, SHORT)
    shorts.set(short, (shorts.get(short) ?? 0) + 1)
  }
  const tokens = new Map(
    paths.map(path => {
      const hash = hashOf(path)
      const short = hash.slice(0, SHORT)
      return [path, shorts.get(short) === 1 ? short : hash] as const
    }),
  )
  tokenIndexes.set(categories, tokens)
  return tokens
}

const sectionToken = (category: Category) => `${SECTION}${category.id}`

export function cleanTokens(value: string) {
  return value
    .split(SEPARATOR)
    .filter(token => TOKEN.test(token))
    .join(SEPARATOR)
}

function tokenSet(value: string) {
  return new Set(value.split(SEPARATOR))
}

function pickedIn(category: Category, add: ReadonlySet<string>, drop: ReadonlySet<string>) {
  const section = sectionToken(category)
  if (add.has(section)) return true
  return drop.has(section) ? false : null
}

export function rowSelectionOf(categories: readonly Category[], picks: Picks): RowSelectionState {
  const tokens = tokensOf(categories)
  const add = tokenSet(picks.add)
  const drop = tokenSet(picks.drop)
  const on: RowSelectionState = {}
  for (const category of categories) {
    const whole = pickedIn(category, add, drop)
    for (const item of category.items.filter(pickable)) {
      const token = tokens.get(item.path) ?? ''
      if (add.has(token) || (!drop.has(token) && (whole ?? item.preselect))) on[item.path] = true
    }
  }
  return on
}

interface Delta {
  whole: '' | 'add' | 'drop'
  add: readonly Item[]
  drop: readonly Item[]
}

const sizeOf = (delta: Delta) => Number(delta.whole !== '') + delta.add.length + delta.drop.length

function deltaOf(items: readonly Item[], on: RowSelectionState): Delta {
  const isOn = (item: Item) => on[item.path] === true
  const options: Delta[] = [
    {whole: '', add: items.filter(i => isOn(i) && !i.preselect), drop: items.filter(i => !isOn(i) && i.preselect)},
    {whole: 'add', add: [], drop: items.filter(i => !isOn(i))},
    {whole: 'drop', add: items.filter(isOn), drop: []},
  ]
  return options.reduce((best, option) => (sizeOf(option) < sizeOf(best) ? option : best))
}

export function picksOf(categories: readonly Category[], on: RowSelectionState): Picks {
  const tokens = tokensOf(categories)
  const tokenOf = (item: Item) => tokens.get(item.path) ?? ''
  const add: string[] = []
  const drop: string[] = []
  for (const category of categories) {
    const delta = deltaOf(category.items.filter(pickable), on)
    if (delta.whole === 'add') add.push(sectionToken(category))
    if (delta.whole === 'drop') drop.push(sectionToken(category))
    add.push(...delta.add.map(tokenOf))
    drop.push(...delta.drop.map(tokenOf))
  }
  return {add: add.join(SEPARATOR), drop: drop.join(SEPARATOR)}
}

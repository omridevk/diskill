import {defineChart, type ChartPoint} from '@tanstack/charts'
import {sunburst, type SunburstNode} from '@tanstack/charts/hierarchy/sunburst'
import {treemap, type TreemapNode} from '@tanstack/charts/hierarchy/treemap'
import {motion} from '@tanstack/charts/motion'
import {polar} from '@tanstack/charts/polar'
import {RendererChart as Chart} from '@tanstack/charts/react/tooltip'
import {Fragment, useMemo, useState, type ReactNode} from 'react'
import {Badge} from '@/components/ui/badge'
import {ChartBoundary} from './chart-boundary'
import {BigBytes, CARD_TOOLTIP, ChartCard, changedAgo, Meter, shareOf} from './chart-card'
import {RISK_BAR} from './cleanup'
import {ToggleGroup, ToggleGroupItem} from '@/components/ui/toggle-group'
import {formatBytes, type Category, type ScanData, type TreeNode} from '@/lib/data'
import type {Selection} from '@/lib/selection'
import {squarifyInBounds} from '@/lib/treemap-tile'

interface Row {
  id: string
  parent: string | undefined
  name: string
  value: number
  node: TreeNode
}

type Shape = 'sunburst' | 'treemap'

const renderer = motion({initial: false})

const HUES = [210, 28, 152, 340, 265, 46, 190, 120, 8, 300, 172, 65]

function tone(hue: number, depth: number) {
  const level = Math.min(Math.max(depth, 1), 3) - 1
  return `hsl(${hue} ${[62, 52, 44][level]}% ${[52, 60, 67][level]}%)`
}

function flatten(root: TreeNode): {rows: Row[]; parents: Map<string, TreeNode>; byPath: Map<string, TreeNode>} {
  const rows: Row[] = []
  const parents = new Map<string, TreeNode>()
  const byPath = new Map<string, TreeNode>()
  const visit = (node: TreeNode, parent: TreeNode | undefined) => {
    byPath.set(node.path, node)
    if (parent) parents.set(node.path, parent)
    rows.push({id: node.path, parent: parent?.path, name: node.name, value: node.children.length ? 0 : node.bytes, node})
    node.children.forEach(child => visit(child, node))
  }
  visit(root, undefined)
  return {rows, parents, byPath}
}

function subtree(root: TreeNode, depth: number): Row[] {
  const rows: Row[] = []
  const visit = (node: TreeNode, parent: string | undefined, level: number) => {
    const leaf = level === depth || node.children.length === 0
    rows.push({id: node.path, parent, name: node.name, value: leaf ? node.bytes : 0, node})
    if (!leaf) node.children.forEach(child => visit(child, node.path, level + 1))
  }
  visit(root, undefined, 0)
  return rows
}

function nodeOf(point: ChartPoint | null) {
  const datum = point?.datum as SunburstNode<Row> | TreemapNode<Row> | undefined
  return datum?.data?.node ?? null
}

function homeOf(root: TreeNode): string {
  if (root.name === '~') return root.path
  return root.children.map(homeOf).find(Boolean) ?? ''
}

function tilde(path: string, home: string) {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

function titleOf(node: TreeNode) {
  if (node.path === '/') return 'Whole disk'
  return node.name === '~' ? 'Home folder' : node.name
}

function cleanupInside(path: string, categories: readonly Category[], selection: Selection) {
  const prefix = path.endsWith('/') ? path : `${path}/`
  const inside = categories
    .filter(c => c.risk !== 'report')
    .flatMap(c => c.items.filter(i => i.path === path || i.path.startsWith(prefix)).map(item => ({item, risk: c.risk})))
  return {
    bytes: inside.reduce((sum, i) => sum + i.item.bytes, 0),
    count: inside.length,
    selected: inside.filter(i => selection.isOn(i.item)).reduce((sum, i) => sum + i.item.bytes, 0),
    risk: inside.some(i => i.risk === 'review') ? ('review' as const) : ('safe' as const),
  }
}

function FolderCard({node, parents, data, home, selection}: {node: TreeNode | null; parents: Map<string, TreeNode>; data: ScanData; home: string; selection: Selection}) {
  if (!node) return null
  const parent = parents.get(node.path)
  const total = data.total
  const top = node.children.filter(c => !c.rest).slice(0, 3)
  const cleanup = cleanupInside(node.path, data.categories, selection)
  return (
    <ChartCard title={titleOf(node)} subtitle={tilde(node.path, home)} hint={node.children.length > 0 ? 'Click to zoom' : undefined}>
      <BigBytes bytes={node.bytes} />
      <div className="flex flex-col gap-2">
        {parent && <Meter label={`of ${titleOf(parent)}`} share={shareOf(node.bytes, parent.bytes)} />}
        <Meter label="of the disk" share={shareOf(node.bytes, total)} />
      </div>
      <Activity node={node} />
      {top.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-2.5">
          {top.map(child => (
            <Meter key={child.path} label={child.name} value={formatBytes(child.bytes)} share={shareOf(child.bytes, node.bytes)} color="var(--color-zinc-500)" />
          ))}
        </div>
      )}
      <Cleanable {...cleanup} />
    </ChartCard>
  )
}

function Activity({node}: {node: TreeNode}) {
  const parts = [node.files > 0 && `${node.files.toLocaleString()} files`, node.mtime > 0 && `changed ${changedAgo(node.mtime)}`].filter(Boolean)
  if (parts.length === 0) return null
  return <div className="text-muted-foreground">{parts.join(' · ')}</div>
}

function Cleanable({bytes, count, selected, risk}: ReturnType<typeof cleanupInside>) {
  if (count === 0) return null
  return (
    <div className="flex items-center gap-2 border-t pt-2.5">
      <span className={`size-2 shrink-0 rounded-full ${RISK_BAR[risk]}`} />
      <span>
        {formatBytes(bytes)} cleanable in {count} {count === 1 ? 'item' : 'items'} · {formatBytes(selected)} selected
      </span>
    </div>
  )
}

function BranchHighlight({node, parents, children}: {node: TreeNode | null; parents: Map<string, TreeNode>; children: ReactNode}) {
  const lit: string[] = []
  for (let n = node ?? undefined; n; n = parents.get(n.path)) lit.push(`.storage-chart[data-hovering] [data-ts-key$=":${CSS.escape(n.path)}"]`)
  return (
    <div className="storage-chart" data-hovering={node ? '' : undefined}>
      {node && <style>{`${lit.join(',')} {opacity: 1}`}</style>}
      {children}
    </div>
  )
}

function Reconciliation({data}: {data: ScanData}) {
  const other = Math.max(0, data.used - data.home)
  const reserved = Math.max(0, data.total - data.used - data.free)
  const rows: [string, number, string, string][] = [
    ['Your home folder', data.home, 'bg-blue-400', 'everything under ~, mapped above'],
    ['Rest of the data volume', other, 'bg-zinc-500', '/Applications, other users, /usr/local, system-wide caches'],
    ['macOS system volume and APFS reserve', reserved, 'bg-amber-500', 'sealed system, Preboot, Recovery, swap and snapshots; not user-deletable'],
    ['Free right now', data.free, 'bg-emerald-500/50', ''],
  ]
  return (
    <section className="flex flex-col gap-1 rounded-xl border p-4">
      <h3 className="pb-2 text-sm font-semibold">Where your {formatBytes(data.total)} went</h3>
      {data.home > data.used && (
        <p className="pb-2 text-xs text-muted-foreground">
          du counts {formatBytes(data.home - data.used)} more than the disk holds: APFS clones and snapshots share blocks.
        </p>
      )}
      {rows.map(([name, bytes, color, hint]) => (
        <div key={name} className="grid grid-cols-[12px_minmax(0,1fr)_90px_56px] items-center gap-3 py-1.5">
          <span className={`size-2.5 rounded-[3px] ${color}`} />
          <span className="text-[13px]">
            {name}
            {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
          </span>
          <span className="text-right text-[13px] tabular-nums">{formatBytes(bytes)}</span>
          <span className="text-right text-xs text-muted-foreground tabular-nums">{((bytes / data.total) * 100).toFixed(1)}%</span>
        </div>
      ))}
      {data.snapshots > 0 && (
        <p className="pt-1 text-xs text-muted-foreground">
          {data.snapshots} local Time Machine snapshot{data.snapshots === 1 ? '' : 's'} sit inside the reserve row; macOS
          purges them when space runs low.
        </p>
      )}
    </section>
  )
}

export function Storage({data, cleanable, selection}: {data: ScanData; cleanable: Set<string>; selection: Selection}) {
  const [shape, setShape] = useState<Shape>('sunburst')
  const tree = data.tree
  const flat = useMemo(() => (tree ? flatten(tree) : null), [tree])
  const [focus, setFocus] = useState(tree?.path ?? '')
  const [hover, setHover] = useState<TreeNode | null>(null)

  const definition = useMemo(() => {
    if (!flat || !tree) return null
    const stroke = (node: {data: Row | null}) => (node.data && cleanable.has(node.data.id) ? '#fafafa' : '#0a0a0a')
    const focusNode = flat.byPath.get(focus)
    const hueOf = new Map((focusNode?.children ?? []).map((child, i) => [child.path, HUES[i % HUES.length] ?? 210]))
    const fill = (branch: string, depth: number) => tone(hueOf.get(branch) ?? 210, depth)
    const shared = {
      scales: {x: null, y: null},
      motion: {transition: {type: 'tween', duration: 480, easing: 'ease-in-out'}},
      tooltip: CARD_TOOLTIP,
      focusRing: false,
    } as const
    if (shape === 'sunburst') {
      return defineChart({
        marks: [
          polar({
            marks: [
              sunburst(flat.rows, {
                id: 'storage-sunburst',
                nodeId: 'id',
                parentId: 'parent',
                value: 'value',
                rootId: focus,
                visibleDepth: 3,
                innerRadius: ({radius}) => radius * 0.28,
                fill: node => fill(node.branchId ?? node.id, node.depth),
                stroke,
                strokeWidth: 1,
              }),
            ],
            scales: {angle: null, radius: null},
          }),
        ],
        ...shared,
      })
    }
    return defineChart({
      marks: [
        treemap(subtree(flat.byPath.get(focus) ?? tree, 2), {
          id: 'storage-treemap',
          nodeId: 'id',
          parentId: 'parent',
          value: 'value',
          method: squarifyInBounds,
          fill: node => fill(node.ancestorIds[1] ?? node.id, node.depth),
          label: node => node.data?.name ?? node.name,
          labelFill: '#09090b',
          radius: 3,
          stroke,
          strokeWidth: 1,
        }),
      ],
      ...shared,
    })
  }, [flat, shape, focus, cleanable, tree])

  if (!tree || !flat || !definition) {
    return <div className="p-10 text-center text-sm text-muted-foreground">No storage map in this run. Re-run the scan to build one.</div>
  }

  const focusNode = flat.byPath.get(focus) ?? tree
  const home = homeOf(tree)
  const chain: TreeNode[] = []
  for (let n: TreeNode | undefined = focusNode; n; n = flat.parents.get(n.path)) chain.unshift(n)
  const shown = hover ?? focusNode

  const drill = (point: ChartPoint | null) => {
    let node = nodeOf(point)
    while (shape === 'treemap' && node) {
      const parent = flat.parents.get(node.path)
      if (!parent || parent.path === focus) break
      node = parent
    }
    if (node?.children.length) setFocus(node.path)
  }

  return (
    <div className="flex flex-col gap-5 overflow-auto px-7 py-5">
      <div className="flex items-center gap-3">
        <nav aria-label="Folder path" className="flex grow flex-wrap items-center gap-1 text-sm">
          {chain.map((n, i) => (
            <Fragment key={n.path}>
              {i > 0 && <span className="text-muted-foreground">/</span>}
              <button
                type="button"
                className={i === chain.length - 1 ? 'font-semibold' : `text-muted-foreground transition-[color] duration-(--duration-quick) ease-(--ease-smooth-out) motion-reduce:transition-none hover:text-foreground`}
                onClick={() => setFocus(n.path)}
              >
                {n.name}
              </button>
            </Fragment>
          ))}
        </nav>
        <ToggleGroup value={[shape]} onValueChange={v => v[0] && setShape(v[0] as Shape)} variant="outline" size="sm" aria-label="Chart">
          <ToggleGroupItem value="sunburst">Sunburst</ToggleGroupItem>
          <ToggleGroupItem value="treemap">Treemap</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-6">
        <ChartBoundary resetKey={`${shape}:${focus}`}>
          <BranchHighlight node={hover} parents={flat.parents}>
            <Chart
              definition={definition}
              renderer={renderer}
              height={shape === 'sunburst' ? 520 : 480}
              ariaLabel={`Storage ${shape} of ${focusNode.path}`}
              onFocusChange={point => setHover(nodeOf(point))}
              onSelect={drill}
              renderTooltipBody={({primaryPoint}) => <FolderCard node={nodeOf(primaryPoint ?? null)} parents={flat.parents} data={data} home={home} selection={selection} />}
            />
          </BranchHighlight>
        </ChartBoundary>
        <aside className="flex flex-col gap-2 border-l pl-5">
          <div className="font-mono text-xs break-all text-muted-foreground">{shown.path}</div>
          <div className="text-3xl font-bold tracking-tight tabular-nums">{formatBytes(shown.bytes)}</div>
          <div className="text-xs text-muted-foreground">
            {((shown.bytes / data.total) * 100).toFixed(1)}% of the disk
            {shown !== focusNode ? ` · ${((shown.bytes / focusNode.bytes) * 100).toFixed(1)}% of ${focusNode.name}` : ''}
          </div>
          {cleanable.has(shown.path) && <Badge className="self-start bg-blue-400/15 text-blue-300">cleanable</Badge>}
          <div className="mt-2 flex flex-col gap-1 border-t pt-3">
            {shown.children.slice(0, 8).map(k => (
              <div key={k.path} className="flex items-center gap-2 text-xs">
                <span className={`grow truncate ${k.rest ? 'text-muted-foreground italic' : ''}`}>{k.name}</span>
                <span className="tabular-nums">{formatBytes(k.bytes)}</span>
              </div>
            ))}
          </div>
          <p className="mt-auto text-xs text-muted-foreground">
            Click a {shape === 'sunburst' ? 'ring' : 'tile'} to zoom in, a crumb to go back. White outlines mark folders the Cleanup tab can delete.
          </p>
        </aside>
      </div>
      <Reconciliation data={data} />
    </div>
  )
}

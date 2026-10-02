import {barX, cell, defineChart} from '@tanstack/charts'
import {Chart} from '@tanstack/charts/react'
import {scaleBand} from '@tanstack/charts/scales/band'
import {scaleLinear as linear} from '@tanstack/charts/scales/linear'
import {tooltip} from '@tanstack/charts/tooltip'
import {scaleLinear} from 'd3-scale'
import {useMemo, type ReactNode} from 'react'
import {ChartBoundary} from './chart-boundary'
import {formatBytes, type Category, type Insights as InsightsData} from '@/lib/data'

const HEAT = ['#18181b', '#60a5fa']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const IDLE_BUCKETS: [string, number][] = [
  ['today', 0],
  ['<1w', 7],
  ['<1m', 30],
  ['<3m', 90],
  ['<1y', 365],
  ['1y+', Infinity],
]

function heat(max: number) {
  return () => scaleLinear<string>().domain([0, Math.max(1, max)]).range(HEAT)
}

function Panel({title, hint, children, wide}: {title: string; hint: string; children: ReactNode; wide?: boolean}) {
  return (
    <section className={`flex flex-col gap-3 rounded-xl border bg-card p-4 ${wide ? 'col-span-2' : ''}`}>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <ChartBoundary resetKey={title}>{children}</ChartBoundary>
    </section>
  )
}

function Calendar({days}: {days: InsightsData['modified_by_day']}) {
  const definition = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = new Date(today)
    start.setDate(start.getDate() - 364 - start.getDay())
    const byDay = new Map(days.map(d => [d.day, d]))
    const cells = []
    for (const date = new Date(start); date <= today; date.setDate(date.getDate() + 1)) {
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      const week = Math.floor((date.getTime() - start.getTime()) / (7 * 86_400_000))
      const found = byDay.get(day)
      cells.push({day, week: String(week), weekday: WEEKDAYS[date.getDay()] ?? '', bytes: found?.bytes ?? 0, files: found?.files ?? 0})
    }
    const weeks = [...new Set(cells.map(c => c.week))]
    const sorted = cells.map(c => c.bytes).toSorted((a, b) => a - b)
    const cap = sorted[Math.floor(sorted.length * 0.97)] ?? 1
    return defineChart({
      marks: [
        cell(cells, {
          x: 'week',
          y: 'weekday',
          color: row => Math.min(row.bytes, cap),
          key: 'day',
          inset: 1.5,
        }),
      ],
      scales: {
        x: {scale: () => scaleBand<string>().domain(weeks), axis: false},
        y: {scale: () => scaleBand<string>().domain(WEEKDAYS), axis: {label: ''}},
      },
      color: {scale: heat(cap)},
      tooltip: {use: tooltip, format: point => `${point.datum.day}: ${formatBytes(point.datum.bytes)} in ${point.datum.files} files`},
    })
  }, [days])
  return <Chart definition={definition} height={170} ariaLabel="Bytes by last-modified day over the past year" />
}

function FolderAge({data}: {data: InsightsData['age_by_folder']}) {
  const definition = useMemo(() => {
    const cells = data.folders.flatMap(f => data.buckets.map((bucket, i) => ({folder: f.path, bucket, bytes: f.bytes[i] ?? 0})))
    const max = Math.max(...cells.map(c => c.bytes))
    return defineChart({
      marks: [cell(cells, {x: 'bucket', y: 'folder', color: 'bytes', key: row => `${row.folder}|${row.bucket}`, inset: 1.5})],
      scales: {
        x: {scale: () => scaleBand<string>().domain(data.buckets), axis: {label: 'Last modified'}},
        y: {scale: () => scaleBand<string>().domain(data.folders.map(f => f.path)), axis: {label: ''}},
      },
      color: {scale: heat(max)},
      tooltip: {use: tooltip, format: point => `${point.datum.folder} · ${point.datum.bucket}: ${formatBytes(point.datum.bytes)}`},
    })
  }, [data])
  return <Chart definition={definition} height={36 + data.folders.length * 26} ariaLabel="Folder size by last-modified age" />
}

function Kinds({kinds}: {kinds: InsightsData['by_kind']}) {
  const definition = useMemo(
    () =>
      defineChart({
        marks: [barX(kinds, {x: 'bytes', y: 'kind', key: 'kind', fill: '#60a5fa', radius: 3, inset: 3})],
        scales: {
          x: {scale: linear, nice: true, grid: true, axis: {label: 'Bytes', ticks: {format: (v: number) => formatBytes(v)}}},
          y: {scale: () => scaleBand<string>().domain(kinds.map(k => k.kind)), axis: {label: ''}},
        },
        tooltip: {use: tooltip, format: point => `${point.datum.kind}: ${formatBytes(point.datum.bytes)} in ${point.datum.files} files`},
      }),
    [kinds],
  )
  return <Chart definition={definition} height={40 + kinds.length * 26} ariaLabel="Bytes by file kind" />
}

function SectionAge({categories}: {categories: Category[]}) {
  const definition = useMemo(() => {
    const rows = categories.filter(c => c.items.some(i => i.age !== null))
    const cells = rows.flatMap(c =>
      IDLE_BUCKETS.map(([bucket], index) => {
        const low = index === 0 ? -1 : (IDLE_BUCKETS[index - 1]?.[1] ?? 0)
        const high = IDLE_BUCKETS[index]?.[1] ?? Infinity
        const bytes = c.items.filter(i => i.age !== null && i.age > low && i.age <= (index === 0 ? 0 : high)).reduce((s, i) => s + i.bytes, 0)
        return {section: c.title, bucket, bytes}
      }),
    )
    const max = Math.max(...cells.map(c => c.bytes))
    return {
      height: 36 + rows.length * 26,
      chart: defineChart({
        marks: [cell(cells, {x: 'bucket', y: 'section', color: 'bytes', key: row => `${row.section}|${row.bucket}`, inset: 1.5})],
        scales: {
          x: {scale: () => scaleBand<string>().domain(IDLE_BUCKETS.map(([b]) => b)), axis: {label: 'Idle for'}},
          y: {scale: () => scaleBand<string>().domain(rows.map(c => c.title)), axis: {label: ''}},
        },
        color: {scale: heat(max)},
        tooltip: {use: tooltip, format: point => `${point.datum.section} · idle ${point.datum.bucket}: ${formatBytes(point.datum.bytes)}`},
      }),
    }
  }, [categories])
  return <Chart definition={definition.chart} height={definition.height} ariaLabel="Cleanup sections by idle time" />
}

export function Insights({insights, categories}: {insights: InsightsData | null | undefined; categories: Category[]}) {
  return (
    <div className="grid grid-cols-2 gap-4 overflow-auto px-7 py-5">
      {insights ? (
        <>
          <Panel wide title="When your files last changed" hint="Bytes by last-modified day over the past year. Bright days are when the disk filled.">
            <Calendar days={insights.modified_by_day} />
          </Panel>
          <Panel title="How old each big folder is" hint="Bytes in the largest folders under ~, by last-modified age.">
            <FolderAge data={insights.age_by_folder} />
          </Panel>
          <Panel title="What kind of data" hint="Bytes by file kind across your home folder.">
            <Kinds kinds={insights.by_kind} />
          </Panel>
        </>
      ) : (
        <p className="col-span-2 rounded-xl border p-4 text-sm text-muted-foreground">Re-run the scan to see when and what filled the disk.</p>
      )}
      <Panel title="Cleanup sections by idle time" hint="Bytes the Cleanup tab can act on, by days since last use.">
        <SectionAge categories={categories} />
      </Panel>
      {insights && (
        <Panel title="Largest files" hint="The biggest single files under ~.">
          <div className="flex max-h-80 flex-col overflow-auto">
            {insights.largest_files.map(f => (
              <div key={f.path} className="flex items-center gap-3 py-1 text-xs">
                <span className="grow truncate font-mono">{f.path}</span>
                <span className="text-muted-foreground tabular-nums">{new Date(f.mtime * 1000).toLocaleDateString()}</span>
                <span className="w-16 text-right tabular-nums">{formatBytes(f.bytes)}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}

import {useEffect, useState, type ReactNode} from 'react'
import {formatBytes, type ScanData} from '@/lib/data'
import {cssMs, useReducedMotion} from '@/lib/motion'
import type {Selection} from '@/lib/selection'
import {DISK_COLORS, DiskDonut} from './disk-donut'
import {FlowField} from './radiant/flow-field'
import {SpinningBytes} from './numbers'

function Legend({color, label, outlined}: {color: string; label: string; outlined?: boolean}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`size-2 rounded-[2px] ${outlined ? 'border border-zinc-600' : ''}`} style={{background: color}} />
      {label}
    </div>
  )
}

function LoadingBackdrop({scanning}: {scanning: boolean}) {
  const reduced = useReducedMotion()
  const [present, setPresent] = useState(scanning)
  if (scanning && !present) setPresent(true)
  useEffect(() => {
    if (scanning) return
    const timer = setTimeout(() => setPresent(false), reduced ? 0 : cssMs('--backdrop-dur', 500))
    return () => clearTimeout(timer)
  }, [scanning, reduced])
  if (!present) return null
  return (
    <div className="t-backdrop pointer-events-none absolute inset-0 -z-10" data-state={scanning ? 'in' : 'out'}>
      <FlowField className="size-full" />
    </div>
  )
}

export function Summary({
  data,
  selection,
  bytes,
  overlay,
  counter,
  status,
  scanning,
}: {
  data: ScanData
  selection: Selection
  bytes: number
  overlay: ReactNode
  counter: ReactNode
  status: ReactNode
  scanning: boolean
}) {
  const sections = new Set(
    data.categories.filter(c => c.items.some(i => selection.isOn(i))).map(c => c.id),
  ).size
  const freeAfter = data.free + selection.exactBytes
  return (
    <section className="relative isolate flex items-center gap-7 border-b px-7 py-5">
      <LoadingBackdrop scanning={scanning} />
      <DiskDonut used={data.used} selected={selection.exactBytes} free={data.free} total={data.total} size={132} />
      <div className="flex grow flex-col gap-2">
        <div className="text-xs text-muted-foreground">Selected to free</div>
        <div className="relative h-12 text-5xl leading-none font-bold tracking-tighter tabular-nums">
          <div className={overlay ? 'invisible' : undefined}>
            <SpinningBytes bytes={bytes} />
          </div>
          {overlay}
        </div>
        {counter}
        <div className="text-[13px] text-muted-foreground">
          {selection.selected.length} items in {sections} sections · free space goes from{' '}
          <b className="font-medium text-foreground">{formatBytes(data.free)}</b> to{' '}
          <b className="font-medium text-foreground">{formatBytes(freeAfter)}</b> of {formatBytes(data.total)}
        </div>
        <div className="flex h-5 items-center gap-3">{status}</div>
      </div>
      <div className="flex flex-col gap-2 self-end text-xs text-muted-foreground">
        <Legend color={DISK_COLORS.used} label="Used" />
        <Legend color={DISK_COLORS.selected} label="Selected" />
        <Legend color={DISK_COLORS.free} label="Free" outlined />
        {selection.apparentBytes > 0 && (
          <div>+ ≈{formatBytes(selection.apparentBytes)} apparent (Docker VM, clones), not counted</div>
        )}
      </div>
    </section>
  )
}

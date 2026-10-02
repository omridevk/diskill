import type {ReactNode} from 'react'
import {formatBytes, type ScanData} from '@/lib/data'
import type {Selection} from '@/lib/selection'
import {DISK_COLORS, DiskDonut} from './disk-donut'
import {SpinningBytes} from './numbers'

function Legend({color, label, outlined}: {color: string; label: string; outlined?: boolean}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`size-2 rounded-[2px] ${outlined ? 'border border-zinc-600' : ''}`} style={{background: color}} />
      {label}
    </div>
  )
}

function LoadingBackdrop() {
  return null
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
    <section className="relative flex items-center gap-7 border-b px-7 py-5">
      {scanning && <LoadingBackdrop />}
      <DiskDonut used={data.used} selected={selection.exactBytes} free={data.free} size={132} />
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
        {status && <div className="flex h-5 items-center">{status}</div>}
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

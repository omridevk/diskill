import {defineChart} from '@tanstack/charts'
import {pie, polar, radialArc} from '@tanstack/charts/polar'
import {motion} from '@tanstack/charts/motion'
import {Chart} from '@tanstack/charts/react/core'
import {useMemo} from 'react'
import {formatBytes} from '@/lib/data'
import {cssMs} from '@/lib/motion'
import {PopBytes} from './numbers'

const renderer = motion({initial: false})

export const DISK_COLORS = {used: '#52525b', selected: '#60a5fa', free: '#27272a'}

interface Part {
  part: 'used' | 'selected' | 'free'
  bytes: number
}

export function DiskDonut({used, selected, free, size}: {used: number; selected: number; free: number; size: number}) {
  const definition = useMemo(() => {
    const parts: Part[] = [
      {part: 'used', bytes: Math.max(0, used - selected)},
      {part: 'selected', bytes: selected},
      {part: 'free', bytes: free},
    ]
    return defineChart({
      marks: [
        polar({
          inset: 2,
          marks: [
            radialArc(pie(parts, {value: 'bytes'}), {
              innerRadius: ({radius}) => radius * 0.76,
              color: 'part',
              key: 'part',
            }),
          ],
          scales: {angle: null, radius: null},
        }),
      ],
      scales: {x: null, y: null},
      motion: {transition: {type: 'tween', duration: cssMs('--duration-fast', 250), easing: 'ease-out'}},
      color: {domain: ['used', 'selected', 'free'], range: [DISK_COLORS.used, DISK_COLORS.selected, DISK_COLORS.free]},
    })
  }, [used, selected, free])

  return (
    <div className="relative shrink-0" style={{width: size, height: size}}>
      <Chart
        definition={definition}
        renderer={renderer}
        width={size}
        height={size}
        tabIndex={-1}
        ariaLabel={`Disk: ${formatBytes(used - selected)} used after cleanup, ${formatBytes(selected)} selected, ${formatBytes(free)} free now`}
      />
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[11px] text-muted-foreground">free after</span>
        <span className="text-lg font-bold tracking-tight tabular-nums">
          <PopBytes bytes={free + selected} />
        </span>
      </div>
    </div>
  )
}

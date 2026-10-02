import {useState} from 'react'
import {formatBytes} from '@/lib/data'
import {useReducedMotion} from '@/lib/motion'
import type {Progress, Scan} from '@/lib/scan'
import ParticleText from './react-bits/particle-text'

const DIR_CHARS = 64

function shorten(dir: string) {
  return dir.length > DIR_CHARS ? `…${dir.slice(-(DIR_CHARS - 1))}` : dir
}

function Title({text}: {text: string}) {
  const reduced = useReducedMotion()
  if (reduced) return <span className="flex h-16 items-center text-5xl font-bold tracking-tighter tabular-nums">{text}</span>
  return (
    <div className="relative h-16 w-fit">
      <span aria-hidden className="invisible block text-[44px] leading-[4rem] font-bold whitespace-nowrap">
        {text}
      </span>
      <div className="absolute -inset-x-10 inset-y-0">
        <ParticleText
          text={text}
          color="#fafafa"
          highlightColor="#60a5fa"
          fontSize={44}
          fontWeight={700}
          particleSize={1.6}
          density={2}
          scatter={60}
          repelRadius={60}
          style={{minHeight: 0}}
        />
      </div>
    </div>
  )
}

function Counter({progress, walked}: {progress: Progress; walked: boolean}) {
  if (walked) return <div className="text-[13px] text-muted-foreground">reclaimable so far</div>
  return (
    <div className="flex min-w-0 items-baseline gap-3 text-[13px] text-muted-foreground tabular-nums">
      <span className="shrink-0">
        {progress.files.toLocaleString()} files · {formatBytes(progress.bytes)}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground/70" title={progress.dir}>
        {shorten(progress.dir)}
      </span>
    </div>
  )
}

export function ScanHero({scan}: {scan: Scan}) {
  const [total, setTotal] = useState('')
  if (scan.walked && total === '') setTotal(formatBytes(scan.data.reclaimable))
  return (
    <div className="flex flex-col gap-1">
      <Title text={total || 'Scanning your disk…'} />
      <Counter progress={scan.progress} walked={scan.walked} />
    </div>
  )
}

import {useState} from 'react'
import {Button} from '@/components/ui/button'
import {formatBytes} from '@/lib/data'
import {useReducedMotion} from '@/lib/motion'
import type {Progress, Scan} from '@/lib/scan'
import ParticleText from './react-bits/particle-text'

const DIR_CHARS = 72

function LoadingBackdrop() {
  return null
}

function shorten(dir: string) {
  return dir.length > DIR_CHARS ? `…${dir.slice(-(DIR_CHARS - 1))}` : dir
}

function Title({text}: {text: string}) {
  const reduced = useReducedMotion()
  if (reduced) return <h1 className="py-16 text-5xl font-bold tracking-tighter tabular-nums">{text}</h1>
  return (
    <div className="h-64 w-full max-w-5xl">
      <ParticleText
        text={text}
        color="#fafafa"
        highlightColor="#60a5fa"
        fontSize="clamp(2.5rem, 7vw, 5.5rem)"
        fontWeight={700}
        particleSize={2}
        density={3}
      />
    </div>
  )
}

function Counter({progress, walked}: {progress: Progress; walked: boolean}) {
  return (
    <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground tabular-nums">
      <span>{walked ? 'reclaimable so far' : `${progress.files.toLocaleString()} files · ${formatBytes(progress.bytes)}`}</span>
      <span className="font-mono text-xs text-muted-foreground/70" title={progress.dir}>
        {walked ? '' : shorten(progress.dir)}
      </span>
    </div>
  )
}

export function LoadingScreen({scan, error, onCancel}: {scan: Scan; error: string; onCancel: () => void}) {
  const [total, setTotal] = useState('')
  if (scan.walked && total === '') setTotal(formatBytes(scan.data.reclaimable))
  return (
    <div className="relative flex h-svh flex-col items-center justify-center gap-4 overflow-hidden p-6 text-center">
      <LoadingBackdrop />
      <Title text={total || 'Scanning your disk…'} />
      <Counter progress={scan.progress} walked={scan.walked} />
      {error && <p className="text-xs text-red-300">{error}. Nothing was deleted.</p>}
      <Button variant="ghost" size="sm" className="mt-6" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

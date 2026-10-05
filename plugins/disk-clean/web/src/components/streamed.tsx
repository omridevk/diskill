import type {ReactNode} from 'react'
import {useStreaming} from '@/lib/page-data'
import {SkeletonReveal} from './skeleton-reveal'

export function Streamed({children}: {children: ReactNode}) {
  const {live, settled} = useStreaming()
  return live ? <SkeletonReveal ready={settled}>{children}</SkeletonReveal> : children
}

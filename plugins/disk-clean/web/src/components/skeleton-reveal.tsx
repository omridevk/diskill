import type {ReactNode} from 'react'

export function SkeletonReveal({ready, children}: {ready: boolean; children: ReactNode}) {
  return (
    <div className={`t-skel h-full ${ready ? 'is-revealed' : ''}`}>
      <div aria-hidden className={`t-skel-skeleton flex flex-col gap-5 px-7 py-5 ${ready ? '' : 'is-pulsing'}`}>
        <div className="h-7 w-72 rounded-lg bg-muted" />
        <div className="h-96 rounded-xl bg-muted" />
        <div className="h-36 rounded-xl bg-muted" />
      </div>
      <div className="t-skel-content overflow-auto">{ready && children}</div>
    </div>
  )
}

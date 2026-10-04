import {useCallback, useSyncExternalStore} from 'react'

export function useNow(running: boolean, every: number) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!running) return () => {}
      const timer = setInterval(onChange, every)
      return () => clearInterval(timer)
    },
    [running, every],
  )
  return useSyncExternalStore(subscribe, () => (running ? Math.floor(performance.now() / every) * every : 0))
}

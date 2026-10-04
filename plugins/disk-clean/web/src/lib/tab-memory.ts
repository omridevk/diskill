export function createTabMemory() {
  let last: Readonly<Record<string, string>> = {}
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    hrefOf: (tab: string): string | undefined => last[tab],
    remember: (tab: string, href: string) => {
      if (last[tab] === href) return
      last = {...last, [tab]: href}
      for (const listener of listeners) listener()
    },
  }
}

export type TabMemory = ReturnType<typeof createTabMemory>

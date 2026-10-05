import {useHotkeys, type Hotkey} from '@tanstack/react-hotkeys'
import {useRouteContext} from '@tanstack/react-router'
import {useCallback, useState, useSyncExternalStore, type RefObject} from 'react'

export const GROUPS = ['Go to', 'Filter and view', 'Select', 'Clean up', 'Trash', 'Help'] as const

export type Group = (typeof GROUPS)[number]

export interface Command {
  id: string
  name: string
  group: Group
  keywords?: readonly string[]
  hotkey?: Hotkey | readonly Hotkey[]
  checked?: boolean
  enabled: boolean
  run: () => void
}

interface Owner {
  commands: readonly Command[]
}

export function createCommandList() {
  let owners: readonly Owner[] = []
  const listeners = new Set<() => void>()
  const changed = (next: readonly Owner[]) => {
    owners = next
    for (const listener of listeners) listener()
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    owners: () => owners,
    join: (owner: Owner) => {
      changed([...owners, owner])
      return () => changed(owners.filter(other => other !== owner))
    },
  }
}

export type CommandList = ReturnType<typeof createCommandList>

const LAYER = '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]'

const layerOpen = () => document.querySelector('[aria-expanded="true"]') !== null || [...document.querySelectorAll(LAYER)].some(layer => layer.checkVisibility())

export const inOverlay = (event: KeyboardEvent) => layerOpen() || (event.target instanceof Element && event.target.closest(LAYER) !== null)

export const hotkeysOf = (command: Command): readonly Hotkey[] => (command.hotkey === undefined ? [] : [command.hotkey].flat())

const unchanged = () => 0

export function useCommandList() {
  return useRouteContext({from: '__root__', select: context => context.commands})
}

export function useCommands(commands: readonly Command[], scope?: RefObject<HTMLElement | null>) {
  const list = useCommandList()
  const [owner] = useState<Owner>(() => ({commands}))
  owner.commands = commands
  const join = useCallback(() => (scope ? () => {} : list.join(owner)), [list, owner, scope])
  useSyncExternalStore(join, unchanged)
  useHotkeys(
    commands.flatMap(command =>
      hotkeysOf(command).map(hotkey => ({
        hotkey,
        callback: (event: KeyboardEvent) => {
          if (inOverlay(event)) return
          event.preventDefault()
          command.run()
        },
        options: {enabled: command.enabled, meta: {name: command.name, group: command.group}},
      })),
    ),
    {preventDefault: false, stopPropagation: false, ignoreInputs: true, target: scope},
  )
}

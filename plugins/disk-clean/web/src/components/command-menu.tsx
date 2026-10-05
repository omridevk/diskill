import {useHotkeyRegistrations, useHotkeys, type HotkeyRegistrationView} from '@tanstack/react-hotkeys'
import {useState, useSyncExternalStore} from 'react'
import {Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut} from '@/components/ui/command'
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {Kbd} from '@/components/ui/kbd'
import {GROUPS, hotkeysOf, inOverlay, useCommandList, useCommands, type Command as Action, type Group} from '@/lib/commands'
import {usePlatform} from '@/lib/platform'

function PaletteItem({command, onRun}: {command: Action; onRun: (command: Action) => void}) {
  const {label} = usePlatform()
  const [hotkey] = hotkeysOf(command)
  return (
    <CommandItem value={command.id} keywords={[command.name, ...(command.keywords ?? [])]} data-checked={command.checked} onSelect={() => onRun(command)}>
      {command.name}
      {hotkey && <CommandShortcut>{label(hotkey)}</CommandShortcut>}
    </CommandItem>
  )
}

function Palette({onRun}: {onRun: (command: Action) => void}) {
  const list = useCommandList()
  const enabled = useSyncExternalStore(list.subscribe, list.owners).flatMap(owner => owner.commands.filter(command => command.enabled))
  const [search, setSearch] = useState('')
  const item = (command: Action) => <PaletteItem key={command.id} command={command} onRun={onRun} />
  return (
    <Command>
      <CommandInput value={search} onValueChange={setSearch} placeholder="Type a command…" aria-label="Command" />
      <CommandList>
        <CommandEmpty>No matching command.</CommandEmpty>
        {search
          ? enabled.map(item)
          : GROUPS.map(group => {
              const inGroup = enabled.filter(command => command.group === group)
              return (
                inGroup.length > 0 && (
                  <CommandGroup key={group} heading={group}>
                    {inGroup.map(item)}
                  </CommandGroup>
                )
              )
            })}
      </CommandList>
    </Command>
  )
}

function rowsOf(hotkeys: readonly HotkeyRegistrationView[], group: Group, label: (hotkey: HotkeyRegistrationView['hotkey']) => string) {
  const inGroup = hotkeys.filter(registration => registration.options.meta?.group === group)
  const names = [...new Set(inGroup.flatMap(registration => registration.options.meta?.name ?? []))]
  return names.map(name => ({name, keys: [...new Set(inGroup.filter(registration => registration.options.meta?.name === name).map(registration => label(registration.hotkey)))]}))
}

function ShortcutList() {
  const {hotkeys} = useHotkeyRegistrations()
  const {label} = usePlatform()
  return (
    <div className="flex flex-col gap-4">
      {GROUPS.map(group => {
        const rows = rowsOf(hotkeys, group, label)
        if (rows.length === 0) return null
        return (
          <section key={group} className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground/70 uppercase">{group}</h3>
            <ul className="flex flex-col gap-1">
              {rows.map(row => (
                <li key={row.name} className="flex items-center gap-2">
                  <span className="grow">{row.name}</span>
                  {row.keys.map(key => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

export function CommandMenu() {
  const [palette, setPalette] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [next, setNext] = useState<Action | null>(null)
  useHotkeys(
    [
      {
        hotkey: 'Mod+K',
        callback: event => {
          if (!palette && inOverlay(event)) return
          event.preventDefault()
          setPalette(!palette)
        },
        options: {meta: {name: 'Command palette', group: 'Help'}},
      },
    ],
    {preventDefault: false, stopPropagation: false, ignoreInputs: false},
  )
  useCommands([{id: 'shortcuts', name: 'Keyboard shortcuts', group: 'Help', hotkey: '?', enabled: true, run: () => setShortcuts(true)}])
  const ran = (open: boolean) => {
    if (open || !next) return
    setNext(null)
    next.run()
  }
  return (
    <>
      <CommandDialog title="Command palette" description="Search for an action to run" open={palette} onOpenChange={setPalette} onOpenChangeComplete={ran}>
        <Palette
          onRun={command => {
            setNext(command)
            setPalette(false)
          }}
        />
      </CommandDialog>
      <Dialog open={shortcuts} onOpenChange={setShortcuts}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
          </DialogHeader>
          <ShortcutList />
        </DialogContent>
      </Dialog>
    </>
  )
}

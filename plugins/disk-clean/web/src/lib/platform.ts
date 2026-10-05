import {formatForDisplay, type FormatDisplayOptions, type Hotkey} from '@tanstack/react-hotkeys'
import type {Loaded, Platform} from './data'
import {useDb} from './db'

interface PlatformText {
  trash: string
  restoreByHand: string
  putBack: string
  deleteNow: readonly [Hotkey, Hotkey]
  otherHint: string
  reserved: string
  reservedHint: string
  sharedBlocks: string
}

const TEXT: Record<Platform, PlatformText> = {
  macos: {
    trash: 'the macOS Trash',
    restoreByHand: "Finder's Put Back",
    putBack: 'Put back in Finder',
    deleteNow: ['Mod+Alt+Backspace', 'Shift+Backspace'],
    otherHint: '/Applications, other users, /usr/local, system-wide caches',
    reserved: 'macOS system volume and APFS reserve',
    reservedHint: 'sealed system, Preboot, Recovery, swap and snapshots; not user-deletable',
    sharedBlocks: 'APFS clones and snapshots share blocks.',
  },
  linux: {
    trash: 'the Trash',
    restoreByHand: "your file manager's Restore",
    putBack: 'Restored in the file manager',
    deleteNow: ['Shift+Backspace', 'Shift+Delete'],
    otherHint: '/usr, /var, other users, system-wide caches',
    reserved: 'System and reserved space',
    reservedHint: 'blocks the filesystem keeps for itself and for root; not user-deletable',
    sharedBlocks: 'hard links and reflinked copies share blocks.',
  },
}

const KEYS = {
  macos: {platform: 'mac', separatorToken: ''},
  linux: {platform: 'linux'},
} as const satisfies Record<Platform, FormatDisplayOptions>

const platformIn = (loaded: Loaded) => loaded.platform ?? 'macos'

export const hotkeyPlatform = (loaded: Loaded) => KEYS[platformIn(loaded)].platform

export function usePlatform() {
  const platform = platformIn(useDb().loaded)
  return {...TEXT[platform], label: (hotkey: Hotkey) => formatForDisplay(hotkey, KEYS[platform])}
}

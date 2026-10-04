import {useHotkeys} from '@tanstack/react-hotkeys'
import {Eraser, Info, RotateCcw, Trash2, X} from 'lucide-react'
import {useState, type AnimationEvent, type ReactNode} from 'react'
import {Button} from '@/components/ui/button'
import {Kbd} from '@/components/ui/kbd'
import {Popover, PopoverContent, PopoverTitle, PopoverTrigger} from '@/components/ui/popover'
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip'
import type {CleanupProgress, Phase} from '@/lib/progress'
import {formatBytes, plural, sizeOf} from '@/lib/data'
import {cssMs, useReducedMotion} from '@/lib/motion'
import type {Selection} from '@/lib/page-data'
import type {ScanState} from '@/lib/scan-feed'
import {ProgressFooter} from './cleanup-progress'
import {PopBytes} from './numbers'
import FuseButton from './react-bits/fuse-button'
import {useSelectionWarnings, WarningChip} from './selection-warnings'

function UndoCountdown({ms}: {ms: number}) {
  const steps = Math.ceil(ms / 1000)
  const [left, setLeft] = useState(steps)
  const tick = (event: AnimationEvent<HTMLSpanElement>) => setLeft(Math.max(0, steps - Math.round(event.elapsedTime)))
  return (
    <span
      className="t-clock"
      style={{animationDuration: '1000ms', animationIterationCount: steps, animationDelay: `${ms - steps * 1000}ms`}}
      onAnimationIteration={tick}
      onAnimationEnd={() => setLeft(0)}
    >
      Undo ({left}s)
    </span>
  )
}

function undoLabel(reduced: boolean, armed: boolean, ms: number) {
  if (!reduced) return 'Undo'
  return armed ? <UndoCountdown ms={ms} /> : `Undo (${Math.ceil(ms / 1000)}s)`
}

interface FuseAction {
  label: string
  doneLabel: string
  icon: ReactNode
  background: string
  color: string
  onCommit: () => void
}

function FuseAction({label, doneLabel, icon, background, color, onCommit}: FuseAction) {
  const reduced = useReducedMotion()
  const undoWindow = cssMs('--fuse-window', 4000)
  const [armed, setArmed] = useState(false)
  return (
    <FuseButton
      label={label}
      undoLabel={undoLabel(reduced, armed, undoWindow)}
      doneLabel={doneLabel}
      icon={icon}
      size="sm"
      radius={8}
      className="shrink-0"
      background={background}
      color={color}
      fuseColor={reduced ? 'transparent' : '#ef4444'}
      fuseThickness={2}
      undoWindow={undoWindow}
      commitOn="fuseEnd"
      onCommit={onCommit}
      onPhaseChange={phase => setArmed(phase === 'armed')}
    />
  )
}

function hint(scan: ScanState) {
  return !scan.done && scan.error === '' ? 'You can delete what is listed while the scan runs.' : 'Cancel gives you a few seconds to undo.'
}

function HelpLine({scan}: {scan: ScanState}) {
  return (
    <div className="flex h-5 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
      Delete moves files to the Trash, so you can undo
      <Popover>
        <PopoverTrigger render={<Button variant="ghost" size="icon-xs" aria-label="About deleting" />}>
          <Info />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 text-xs">
          <PopoverTitle className="text-sm">How Delete works</PopoverTitle>
          <p className="text-muted-foreground">Delete moves files to the macOS Trash. Undo puts them back; Finder's Put Back works too. Space comes back when the Trash is emptied.</p>
          <p className="text-muted-foreground">Delete immediately skips the Trash and can't be undone. Worktrees and commands can't be undone either.</p>
          <p className="flex flex-wrap items-center gap-1 text-muted-foreground">
            Delete <Kbd>⌘⌫</Kbd> · Delete immediately <Kbd>⌥⌘⌫</Kbd> or <Kbd>⇧⌫</Kbd>
          </p>
          <p className="text-muted-foreground">{hint(scan)}</p>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function deleteState(selection: Selection, scan: ScanState) {
  const count = selection.selected.length
  if (scan.error !== '') return {label: 'The scan failed · nothing can be deleted', ready: false}
  if (count > 0) return {label: `Delete ${plural(count, 'item', 'items')} · ${sizeOf(selection.exactBytes, selection.apparentBytes)}`, ready: true}
  if (selection.selectable > 0) return {label: 'Select items to delete', ready: false}
  if (!scan.done) return {label: 'Scanning… nothing found yet', ready: false}
  return {label: 'Nothing found to delete', ready: false}
}

function SelectionButton({label, icon, shortcut, reason, onClick}: {label: string; icon: ReactNode; shortcut: string; reason: string; onClick: () => void}) {
  const described = reason ? `${label}: ${reason}` : label
  return (
    <Tooltip>
      <TooltipTrigger delay={80} render={<span className="inline-flex" />}>
        <Button variant="ghost" size="icon-xs" disabled={reason !== ''} aria-label={described} onClick={onClick}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {described}
        <Kbd>{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

const DIALOG = '[role="dialog"], [role="alertdialog"]'

const dialogOpen = () => [...document.querySelectorAll(DIALOG)].some(layer => layer.checkVisibility())

function useDeleteShortcuts(enabled: boolean, onDelete: (now: boolean) => void) {
  const press = (now: boolean) => () => {
    if (!dialogOpen()) onDelete(now)
  }
  const options = {enabled, ignoreInputs: true}
  useHotkeys([
    {hotkey: 'Mod+Backspace', callback: press(false), options},
    {hotkey: 'Backspace', callback: press(false), options},
    {hotkey: 'Delete', callback: press(false), options},
    {hotkey: 'Mod+Alt+Backspace', callback: press(true), options},
    {hotkey: 'Shift+Backspace', callback: press(true), options},
  ])
}

export function ActionBar({
  selection,
  scan,
  progress = null,
  phase,
  actions,
  failure,
  onCancel,
  onDelete,
}: {
  selection: Selection
  scan: ScanState
  progress?: CleanupProgress | null
  phase: Phase
  actions?: ReactNode
  failure?: ReactNode
  onCancel: () => void
  onDelete: (now: boolean) => void
}) {
  const warnings = useSelectionWarnings(selection)
  const action = deleteState(selection, scan)
  useDeleteShortcuts(action.ready && !progress, onDelete)
  if (progress) return <ProgressFooter progress={progress} phase={phase} actions={actions} />
  const count = selection.selected.length

  return (
    <footer className="flex items-center gap-2.5 border-t bg-card px-7 py-3.5">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <div className="flex h-6 items-center gap-1">
          <div className="w-64 shrink-0 truncate text-sm font-semibold tabular-nums">
            {plural(count, 'item', 'items')} selected · {selection.exactBytes === 0 && selection.apparentBytes > 0 ? `≈${formatBytes(selection.apparentBytes)}` : <PopBytes bytes={selection.exactBytes} />}
          </div>
          <SelectionButton label="Clear selection" icon={<Eraser />} shortcut="D" reason={count === 0 ? 'nothing is selected' : ''} onClick={selection.clear} />
          <SelectionButton label="Reset to recommended" icon={<RotateCcw />} shortcut="R" reason={selection.recommended ? 'already the recommended selection' : ''} onClick={selection.reset} />
          <div className="flex min-w-0 grow pl-2">
            <WarningChip warnings={warnings} />
          </div>
        </div>
        <HelpLine scan={scan} />
        {failure}
      </div>
      <FuseAction label="Cancel" doneLabel="Cancelling" icon={<X />} background="transparent" color="var(--foreground)" onCommit={onCancel} />
      <Tooltip>
        <TooltipTrigger delay={80} render={<span className="inline-flex shrink-0" />}>
          <Button variant="outline" size="lg" disabled={!action.ready} aria-haspopup="dialog" onClick={() => onDelete(true)}>
            Delete immediately…
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Skips the Trash, can't be undone
          <Kbd>⌥⌘⌫</Kbd>
        </TooltipContent>
      </Tooltip>
      <Button size="lg" className="w-80 shrink-0 justify-start" disabled={!action.ready} aria-haspopup="dialog" onClick={() => onDelete(false)}>
        <Trash2 /> {action.label}
      </Button>
    </footer>
  )
}

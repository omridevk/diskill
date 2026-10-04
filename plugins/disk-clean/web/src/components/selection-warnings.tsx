import {useSearch} from '@tanstack/react-router'
import {TriangleAlert} from 'lucide-react'
import {badgeVariants} from '@/components/ui/badge'
import {Popover, PopoverContent, PopoverTitle, PopoverTrigger} from '@/components/ui/popover'
import {counted, formatBytes, outermost, plural, sumBytes} from '@/lib/data'
import type {Selection} from '@/lib/page-data'
import type {Entry} from '@/lib/scan-feed'
import {CLEANUP_DEFAULTS} from '@/lib/search'
import {isFiltering, predicateOf} from '@/lib/shaping'

export interface SelectionWarnings {
  hidden: Entry[]
  risky: number
}

export function useSelectionWarnings(selection: Selection): SelectionWarnings {
  const shape = {...CLEANUP_DEFAULTS, ...useSearch({strict: false})}
  const keep = predicateOf(shape, selection.rowSelection)
  const hidden = isFiltering(shape) ? selection.selected.filter(entry => !keep(entry)) : []
  return {hidden, risky: selection.risky}
}

export function WarningLines({warnings, className}: {warnings: SelectionWarnings; className?: string}) {
  const {hidden, risky} = warnings
  return (
    <ul className={`flex flex-col gap-1 text-amber-200 ${className ?? ''}`}>
      {hidden.length > 0 && (
        <li>
          {plural(hidden.length, 'selected item is', 'selected items are')} hidden by the filters ({formatBytes(sumBytes(outermost(hidden)))}). They will still be deleted.
        </li>
      )}
      {risky > 0 && <li>{plural(risky, 'item', 'items')} marked review selected: slow or costly to rebuild.</li>}
    </ul>
  )
}

function chipText({hidden, risky}: SelectionWarnings) {
  const parts = [risky > 0 && plural(risky, 'review item', 'review items'), hidden.length > 0 && `${counted(hidden.length)} hidden`]
  return parts.filter(part => part !== false).join(' · ')
}

export function WarningChip({warnings}: {warnings: SelectionWarnings}) {
  const text = chipText(warnings)
  if (text === '') return null
  return (
    <Popover>
      <PopoverTrigger openOnHover delay={80} className={badgeVariants({variant: 'outline', className: 'ml-auto h-6 shrink-0 cursor-pointer border-amber-500/30 bg-amber-500/10 text-amber-300'})}>
        <TriangleAlert /> {text}
      </PopoverTrigger>
      <PopoverContent side="top" className="w-80 text-xs">
        <PopoverTitle className="text-sm">Check before deleting</PopoverTitle>
        <WarningLines warnings={warnings} />
      </PopoverContent>
    </Popover>
  )
}

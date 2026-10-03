import {FlexRender, type ReactTable} from '@tanstack/react-table'
import {useVirtualizer} from '@tanstack/react-virtual'
import {memo, useRef, type MouseEvent} from 'react'
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '@/components/ui/table'
import type {CleanupProgress, Outcome} from '@/lib/cleanup'
import {STATE_MOTION} from '@/lib/motion'
import {toggleRow, type Entry, type EntryRow, type features} from './cleanup-columns'

type CleanupTable = ReactTable<typeof features, Entry>

const GRID = 'grid grid-cols-[36px_minmax(0,1fr)_80px_96px] items-center gap-x-3 px-3'
const OVERSCAN = 6
const LINE = 18
const PADDING = 18

function heightOf(row: EntryRow, planned: boolean) {
  return PADDING + LINE * (1 + Number(row.original.note !== '') + Number(planned))
}

function rowTone(planned: boolean, outcome: Outcome | undefined, locked: boolean) {
  if (!locked) return 'hover:bg-muted/40 data-[state=selected]:bg-blue-400/[0.07]'
  if (!planned) return 'opacity-40 hover:bg-transparent'
  return outcome?.kind === 'removed' ? 'opacity-60 hover:bg-transparent [&_[data-label]]:line-through' : 'hover:bg-transparent'
}

function clickRow(row: EntryRow, event: MouseEvent<HTMLTableRowElement>) {
  if (event.target instanceof Element && event.target.closest('[role="checkbox"]')) return
  toggleRow(row, !row.getIsSelected(), event.nativeEvent)
}

interface RowProps {
  row: EntryRow
  index: number
  start: number
  selected: boolean
  locked: boolean
  planned: boolean
  outcome: Outcome | undefined
  pending: string
  measure: (node: Element | null) => void
}

const VirtualRow = memo(function VirtualRow({row, index, start, selected, locked, planned, outcome, measure}: RowProps) {
  return (
    <TableRow
      ref={measure}
      data-index={index}
      data-state={!locked && selected ? 'selected' : undefined}
      role="row"
      aria-rowindex={index + 2}
      onClick={locked || !row.getCanSelect() ? undefined : event => clickRow(row, event)}
      className={`absolute top-0 left-0 w-full rounded-lg border-0 py-2 ${GRID} ${locked ? '' : 'cursor-pointer'} ${STATE_MOTION} ${rowTone(planned, outcome, locked)}`}
      style={{transform: `translateY(${start}px)`}}
    >
      {row.getVisibleCells().map(cell => (
        <TableCell key={cell.id} role="cell" className="min-w-0 p-0 whitespace-normal">
          <FlexRender cell={cell} />
        </TableCell>
      ))}
    </TableRow>
  )
})

function pendingOf(progress: CleanupProgress | null) {
  if (!progress) return ''
  if (progress.cleanup.done) return 'not run'
  return progress.cleanup.started ? 'deleting' : 'queued'
}

export function DataTable({table, rows, label}: {table: CleanupTable; rows: readonly EntryRow[]; label: string}) {
  const scroller = useRef<HTMLDivElement>(null)
  const progress = table.options.meta?.progress ?? null
  const plan = progress?.plan.items
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: index => {
      const row = rows[index]
      return row ? heightOf(row, plan?.has(row.id) ?? false) : LINE + PADDING
    },
    getItemKey: index => rows[index]?.id ?? index,
    overscan: OVERSCAN,
  })
  const pending = pendingOf(progress)
  return (
    <div ref={scroller} className="min-h-0 grow overflow-auto px-3 py-1">
      <Table aria-label={label} aria-rowcount={rows.length + 1} role="table" className="grid">
        <TableHeader role="rowgroup" className="grid [&_tr]:border-0">
          {table.getHeaderGroups().map(group => (
            <TableRow key={group.id} role="row" aria-rowindex={1} className={`${GRID} hover:bg-transparent`}>
              {group.headers.map(header => (
                <TableHead key={header.id} role="columnheader" className="h-auto px-0 py-2 text-[11px] font-normal tracking-wide text-muted-foreground/70 uppercase">
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody role="rowgroup" className="relative grid" style={{height: virtualizer.getTotalSize()}}>
          {virtualizer.getVirtualItems().map(virtual => {
            const row = rows[virtual.index]
            if (!row) return null
            const planned = plan?.has(row.id) ?? false
            return (
              <VirtualRow
                key={row.id}
                row={row}
                index={virtual.index}
                start={virtual.start}
                selected={row.getIsSelected()}
                locked={progress !== null}
                planned={planned}
                outcome={progress?.byKey.get(row.id)}
                pending={planned ? pending : ''}
                measure={virtualizer.measureElement}
              />
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

import {useTable, type ReactTable, type RowSelectionState, type Updater} from '@tanstack/react-table'
import {useVirtualizer} from '@tanstack/react-virtual'
import {memo, useRef, type MouseEvent} from 'react'
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '@/components/ui/table'
import type {CleanupProgress, Outcome} from '@/lib/progress'
import {STATE_MOTION} from '@/lib/motion'
import {moveWindow, type SectionWindow} from '@/lib/shaping'
import {columns, enableRowSelection, toggleRow, type Entry, type EntryRow, features} from './cleanup-columns'

type CleanupTable = ReactTable<typeof features, Entry, null>

const GRID = 'grid grid-cols-[36px_minmax(0,1fr)_80px_96px] items-center gap-x-3 px-3'
const OVERSCAN = 6
const LINE = 18
const PADDING = 18

function heightOf(row: EntryRow | undefined, planned: boolean) {
  if (!row) return LINE + PADDING
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
  table: CleanupTable
  row: EntryRow
  index: number
  start: number
  locked: boolean
  planned: boolean
  outcome: Outcome | undefined
  measure: (node: Element | null) => void
}

const VirtualRow = memo(function VirtualRow({table, row, index, start, locked, planned, outcome, measure}: RowProps) {
  return (
    <table.Subscribe selector={state => state.rowSelection[row.id] === true}>
      {selected => (
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
          {row.getAllCells().map(cell => (
            <TableCell key={cell.id} role="cell" className="min-w-0 p-0 whitespace-normal">
              <table.FlexRender cell={cell} />
            </TableCell>
          ))}
        </TableRow>
      )}
    </table.Subscribe>
  )
})

interface DataTableProps {
  slice: SectionWindow
  count: number
  label: string
  progress: CleanupProgress | null
  rowSelection: RowSelectionState
  onRowSelectionChange: (update: Updater<RowSelectionState>) => void
}

function useCleanupTable({slice, progress, rowSelection, onRowSelectionChange}: DataTableProps) {
  return useTable(
    {
      features,
      columns,
      data: slice.rows,
      getRowId: row => row.path,
      enableRowSelection,
      state: {rowSelection},
      onRowSelectionChange,
      meta: {progress},
    },
    () => null,
  )
}

export function DataTable(props: DataTableProps) {
  const {slice, count, label, progress} = props
  const scroller = useRef<HTMLDivElement>(null)
  const table = useCleanupTable(props)
  const rows = table.getRowModel().rows
  const rowAt = (index: number) => rows[index - slice.offset]
  const plan = progress?.plan.items
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: index => {
      const row = rowAt(index)
      return heightOf(row, row ? (plan?.has(row.id) ?? false) : false)
    },
    getItemKey: index => rowAt(index)?.id ?? index,
    overscan: OVERSCAN,
    onChange: instance => {
      const range = instance.range
      if (range) moveWindow(slice, range.startIndex, range.endIndex + 1)
    },
  })
  return (
    <div ref={scroller} className="min-h-0 grow overflow-auto px-3 py-1">
      <Table aria-label={label} aria-rowcount={count + 1} role="table" className="grid">
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
            const row = rowAt(virtual.index)
            if (!row) return null
            return (
              <VirtualRow
                key={row.id}
                table={table}
                row={row}
                index={virtual.index}
                start={virtual.start}
                locked={progress !== null}
                planned={plan?.has(row.id) ?? false}
                outcome={progress?.byKey.get(row.id)}
                measure={virtualizer.measureElement}
              />
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

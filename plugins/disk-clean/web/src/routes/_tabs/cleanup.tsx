import {createFileRoute, Outlet, stripSearchParams} from '@tanstack/react-router'
import {Cleanup} from '@/components/cleanup'
import {useProgress, useScanData, useSelection} from '@/lib/page-data'
import {CLEANUP_DEFAULTS, cleanupSearch} from '@/lib/search'

export const Route = createFileRoute('/_tabs/cleanup')({
  validateSearch: cleanupSearch,
  search: {middlewares: [stripSearchParams(CLEANUP_DEFAULTS)]},
  component: CleanupTab,
})

function CleanupTab() {
  const list = Route.useSearch()
  const {categories} = useScanData()
  const selection = useSelection()
  const {progress} = useProgress()
  return (
    <Cleanup categories={categories} selection={selection} list={list} progress={progress}>
      <Outlet />
    </Cleanup>
  )
}

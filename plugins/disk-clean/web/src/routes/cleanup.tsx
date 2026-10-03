import {createFileRoute, stripSearchParams} from '@tanstack/react-router'
import {Cleanup} from '@/components/cleanup'
import {useApp} from '@/components/shell'
import {CLEANUP_DEFAULTS, cleanupSearch} from '@/lib/search'

export const Route = createFileRoute('/cleanup')({
  validateSearch: cleanupSearch,
  search: {middlewares: [stripSearchParams(CLEANUP_DEFAULTS)]},
  component: CleanupTab,
})

function CleanupTab() {
  const list = Route.useSearch()
  const {data, selection, progress} = useApp()
  return <Cleanup categories={data.categories} selection={selection} list={list} progress={progress} />
}

import {createFileRoute, stripSearchParams} from '@tanstack/react-router'
import {Streamed, useApp} from '@/components/shell'
import {Storage} from '@/components/storage'
import {STORAGE_DEFAULTS, storageSearch} from '@/lib/search'

export const Route = createFileRoute('/storage')({
  validateSearch: storageSearch,
  search: {middlewares: [stripSearchParams(STORAGE_DEFAULTS)]},
  component: StorageTab,
})

function StorageTab() {
  const {shape} = Route.useSearch()
  const {data, cleanable, selection} = useApp()
  return (
    <Streamed>
      <Storage data={data} cleanable={cleanable} selection={selection} shape={shape} />
    </Streamed>
  )
}

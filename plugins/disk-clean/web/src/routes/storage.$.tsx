import {createFileRoute, stripSearchParams} from '@tanstack/react-router'
import {Streamed} from '@/components/streamed'
import {Storage} from '@/components/storage'
import {useCleanable, useHome, useScanData, useSelection} from '@/lib/page-data'
import {STORAGE_DEFAULTS, storageSearch} from '@/lib/search'

export const Route = createFileRoute('/storage/$')({
  validateSearch: storageSearch,
  search: {middlewares: [stripSearchParams(STORAGE_DEFAULTS)]},
  component: StorageTab,
})

function StorageTab() {
  const {shape} = Route.useSearch()
  const {_splat} = Route.useParams()
  const data = useScanData()
  const home = useHome()
  const cleanable = useCleanable()
  const selection = useSelection()
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Streamed>
        <Storage data={data} home={home} cleanable={cleanable} selection={selection} shape={shape} zoom={_splat ?? ''} />
      </Streamed>
    </div>
  )
}

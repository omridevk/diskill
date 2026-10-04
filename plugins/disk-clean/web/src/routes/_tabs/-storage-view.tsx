import {getRouteApi} from '@tanstack/react-router'
import {Storage} from '@/components/storage'
import {Streamed} from '@/components/streamed'
import {useCleanable, useHome, useScanData, useSelection} from '@/lib/page-data'

const storage = getRouteApi('/_tabs/storage')

export function StorageView({zoom}: {zoom: string}) {
  const shape = storage.useSearch({select: search => search.shape})
  const data = useScanData()
  const home = useHome()
  const cleanable = useCleanable()
  const selection = useSelection()
  return (
    <Streamed>
      <Storage data={data} home={home} cleanable={cleanable} selection={selection} shape={shape} zoom={zoom} />
    </Streamed>
  )
}

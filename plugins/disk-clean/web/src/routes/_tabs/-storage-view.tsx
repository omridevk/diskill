import {getRouteApi} from '@tanstack/react-router'
import {Storage} from '@/components/storage'
import {Streamed} from '@/components/streamed'

const storage = getRouteApi('/_tabs/storage')

export function StorageView({zoom}: {zoom: string}) {
  const shape = storage.useSearch({select: search => search.shape})
  return (
    <Streamed>
      <Storage shape={shape} zoom={zoom} />
    </Streamed>
  )
}

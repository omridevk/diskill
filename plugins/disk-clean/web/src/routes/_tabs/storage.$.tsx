import {createFileRoute} from '@tanstack/react-router'
import {StorageView} from './-storage-view'

export const Route = createFileRoute('/_tabs/storage/$')({
  component: Zoomed,
})

function Zoomed() {
  const {_splat} = Route.useParams()
  return <StorageView zoom={_splat ?? ''} />
}

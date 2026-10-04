import {createFileRoute, redirect} from '@tanstack/react-router'
import {nearestFolder} from '@/lib/data'
import {scanReady, treeNow} from '@/lib/page-data'
import {StorageView} from './-storage-view'

export const Route = createFileRoute('/_tabs/storage/$')({
  loader: async ({context, params}) => {
    await scanReady(context.db)
    const tree = treeNow(context.db)
    const wanted = `/${params._splat ?? ''}`
    const nearest = tree ? nearestFolder(tree, wanted) : wanted
    if (nearest === wanted) return
    if (tree && nearest === tree.path) throw redirect({to: '/storage', search: true, replace: true})
    throw redirect({to: '/storage/$', params: {_splat: nearest.slice(1)}, search: true, replace: true})
  },
  component: Zoomed,
})

function Zoomed() {
  const {_splat} = Route.useParams()
  return <StorageView zoom={_splat ?? ''} />
}

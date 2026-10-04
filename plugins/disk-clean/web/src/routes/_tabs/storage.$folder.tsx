import {createFileRoute, redirect} from '@tanstack/react-router'
import {folderIndex, folderTokenOf, zoomedPath} from '@/lib/folders'
import {scanReady, treeNow} from '@/lib/page-data'
import {StorageView} from './-storage-view'

export const Route = createFileRoute('/_tabs/storage/$folder')({
  params: {parse: ({folder}) => ({folder: folderTokenOf(folder)})},
  loader: async ({context, params}) => {
    await scanReady(context.db)
    const tree = treeNow(context.db)
    if (!tree) return ''
    const path = zoomedPath(tree, params.folder)
    if (path === tree.path) throw redirect({to: '/storage', search: true, replace: true})
    const folder = folderIndex(tree).tokenOf(path)
    if (folder !== params.folder) throw redirect({to: '/storage/$folder', params: {folder}, search: true, replace: true})
    return path
  },
  component: Zoomed,
})

function Zoomed() {
  return <StorageView zoom={Route.useLoaderData()} />
}

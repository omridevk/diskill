import {createFileRoute, redirect} from '@tanstack/react-router'
import {folderTokenOf} from '@/lib/folders'
import {scanReady} from '@/lib/page-data'
import {StorageView} from './-storage-view'

export const Route = createFileRoute('/_tabs/storage/$folder')({
  params: {parse: ({folder}) => ({folder: folderTokenOf(folder)})},
  loader: async ({context, params}) => {
    await scanReady(context.db)
    const folder = context.db.scan.folders.collection.get(params.folder)
    if (!folder || folder.parent === null) throw redirect({to: '/storage', search: true, replace: true})
    return folder.path
  },
  component: Zoomed,
})

function Zoomed() {
  return <StorageView zoom={Route.useLoaderData()} />
}

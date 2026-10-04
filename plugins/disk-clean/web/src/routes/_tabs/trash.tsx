import {createFileRoute, Outlet, stripSearchParams} from '@tanstack/react-router'
import {TrashView, type TrashActions} from '@/components/trash-view'
import {useDecisions} from '@/lib/page-data'
import {TRASH_DEFAULTS, trashSearch} from '@/lib/search'

export const Route = createFileRoute('/_tabs/trash')({
  validateSearch: trashSearch,
  search: {middlewares: [stripSearchParams(TRASH_DEFAULTS)]},
  component: TrashTab,
})

function picksAfter(pick: string, ids: readonly string[], on: boolean) {
  const picked = new Set(pick.split('.').filter(Boolean))
  for (const id of ids) {
    if (on) picked.add(id)
    else picked.delete(id)
  }
  return [...picked].join('.')
}

function TrashTab() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const {trash, retryTrash} = useDecisions()
  const actions: TrashActions = {
    onPick: (ids, on) => navigate({search: prev => ({...prev, pick: picksAfter(prev.pick ?? '', ids, on)}), replace: true}),
    onUndo: ids => trash('undo', ids),
    onEmpty: target => navigate({to: '/trash/empty', search: prev => ({...prev, target})}),
    onRun: run => navigate({search: prev => ({...prev, run, pick: ''})}),
    onRetry: retryTrash,
  }
  return (
    <>
      <TrashView search={search} actions={actions} />
      <Outlet />
    </>
  )
}

import {useLiveSuspenseQuery} from '@tanstack/react-db'
import {createFileRoute, redirect, useRouter, type ErrorComponentProps} from '@tanstack/react-router'
import {ConfirmDialog, ConfirmFailed} from '@/components/confirm-dialog'
import {messageOf} from '@/lib/api'
import {useDb} from '@/lib/db'
import {useBack, useDialogExit} from '@/lib/navigation'
import {canConfirm, loadPreview, previewOf, useDecisions, useHome} from '@/lib/page-data'

export const Route = createFileRoute('/_tabs/cleanup/$section/confirm')({
  loaderDeps: ({search}) => ({add: search.add, drop: search.drop}),
  beforeLoad: ({context, params, search}) => {
    if (!canConfirm(context.db, search)) throw redirect({to: '/cleanup/$section', params: {section: params.section}, search: true, replace: true})
  },
  loader: ({context, deps}) => loadPreview(context.db, deps),
  pendingMs: 150,
  pendingComponent: Checking,
  errorComponent: Failed,
  component: Confirm,
})

function useExit() {
  const exit = useDialogExit()
  const back = useBack()
  const {section} = Route.useParams()
  const leave = () => back({to: '/cleanup/$section', params: {section}, search: true})
  return {open: exit.open, onClose: () => exit.leave(leave), onClosed: () => exit.then?.(), leave: exit.leave}
}

function Checking() {
  const home = useHome()
  const {leave, ...exit} = useExit()
  return <ConfirmDialog plan={null} home={home} {...exit} onConfirm={exit.onClose} />
}

function Failed({error}: ErrorComponentProps) {
  const router = useRouter()
  const {leave, ...exit} = useExit()
  return <ConfirmFailed message={messageOf(error)} {...exit} onRetry={() => router.invalidate()} />
}

function Confirm() {
  const picks = Route.useLoaderDeps()
  const {data} = useLiveSuspenseQuery(previewOf(useDb(), picks))
  const {approve} = useDecisions()
  const navigate = Route.useNavigate()
  const home = useHome()
  const {leave, ...exit} = useExit()
  const confirm = () => {
    approve(picks)
    leave(() => navigate({to: '/cleanup/$section', params: true, search: true, replace: true}))
  }
  return <ConfirmDialog plan={data[0] ?? null} home={home} {...exit} onConfirm={confirm} />
}

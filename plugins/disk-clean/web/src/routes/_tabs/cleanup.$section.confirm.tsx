import {useLiveSuspenseQuery} from '@tanstack/react-db'
import {createFileRoute, redirect, useRouter, type ErrorComponentProps} from '@tanstack/react-router'
import {ConfirmDialog, ConfirmFailed} from '@/components/confirm-dialog'
import {useSelectionWarnings} from '@/components/selection-warnings'
import {messageOf} from '@/lib/api'
import {useDb} from '@/lib/db'
import {useBack, useDialogExit} from '@/lib/navigation'
import {canConfirm, loadPreview, previewAt, scanReady, useDecisions, useHome, useSelection} from '@/lib/page-data'
import {useScanState} from '@/lib/views'

export const Route = createFileRoute('/_tabs/cleanup/$section/confirm')({
  loaderDeps: ({search}) => ({add: search.add, drop: search.drop}),
  loader: async ({context, deps, params}) => {
    await scanReady(context.db)
    if (!canConfirm(context.db, deps)) throw redirect({to: '/cleanup/$section', params: {section: params.section}, search: true, replace: true})
    return loadPreview(context.db, deps)
  },
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
  return {dialog: {open: exit.open, onClose: () => exit.leave(leave), onClosed: () => exit.after?.()}, leave: exit.leave}
}

function useScanning() {
  return !useScanState(useDb()).done
}

function Checking() {
  const home = useHome()
  const scanning = useScanning()
  const {dialog} = useExit()
  return <ConfirmDialog plan={null} home={home} scanning={scanning} {...dialog} onConfirm={dialog.onClose} />
}

function Failed({error}: ErrorComponentProps) {
  const router = useRouter()
  const {dialog} = useExit()
  return <ConfirmFailed message={messageOf(error)} {...dialog} onRetry={() => router.invalidate()} />
}

function Confirm() {
  const db = useDb()
  const preview = previewAt(db, Route.useLoaderData())
  const {data} = useLiveSuspenseQuery(preview.collection)
  const scanning = useScanning()
  const {approve} = useDecisions()
  const navigate = Route.useNavigate()
  const home = useHome()
  const {dialog, leave} = useExit()
  const warnings = useSelectionWarnings(useSelection())
  const confirm = () => {
    approve(preview)
    leave(() => navigate({to: '/cleanup/$section', params: true, search: true, replace: true}))
  }
  return <ConfirmDialog plan={data[0] ?? null} home={home} selected={preview.items.length} scanning={scanning} warnings={warnings} {...dialog} onConfirm={confirm} />
}

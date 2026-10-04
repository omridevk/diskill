import {createFileRoute, redirect, useRouter, type ErrorComponentProps} from '@tanstack/react-router'
import {ConfirmDialog, ConfirmFailed} from '@/components/confirm-dialog'
import {homeOf} from '@/lib/data'
import {useBack} from '@/lib/navigation'
import {canConfirm, messageOf, planFor, useDecisions, useScanData} from '@/lib/page-data'
import {OpenSection} from './-open-section'

export const Route = createFileRoute('/cleanup/confirm')({
  loaderDeps: ({search}) => ({add: search.add, drop: search.drop}),
  beforeLoad: ({context, search}) => {
    if (!canConfirm(context.page, search)) throw redirect({to: '/cleanup', search: true, replace: true})
  },
  loader: ({context, deps}) => planFor(context.page, deps),
  pendingMs: 150,
  pendingComponent: Checking,
  errorComponent: Failed,
  component: Confirm,
})

function useClose() {
  const back = useBack()
  return () => back({to: '/cleanup', search: true})
}

function Checking() {
  const close = useClose()
  const {tree} = useScanData()
  return (
    <>
      <OpenSection section="" />
      <ConfirmDialog plan={null} home={homeOf(tree)} onClose={close} onConfirm={close} />
    </>
  )
}

function Failed({error}: ErrorComponentProps) {
  const router = useRouter()
  const close = useClose()
  return (
    <>
      <OpenSection section="" />
      <ConfirmFailed message={messageOf(error)} onClose={close} onRetry={() => router.invalidate()} />
    </>
  )
}

function Confirm() {
  const plan = Route.useLoaderData()
  const picks = Route.useLoaderDeps()
  const {approve} = useDecisions()
  const navigate = Route.useNavigate()
  const close = useClose()
  const {tree} = useScanData()
  const confirm = () => {
    navigate({to: '/cleanup', search: true, replace: true})
    approve(picks)
  }
  return (
    <>
      <OpenSection section="" />
      <ConfirmDialog plan={plan} home={homeOf(tree)} onClose={close} onConfirm={confirm} />
    </>
  )
}

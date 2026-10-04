import {createFileRoute, redirect} from '@tanstack/react-router'
import {FreeDialog} from '@/components/free-dialog'
import {freeOffer} from '@/lib/cleanup'
import {useBack, useDialogExit} from '@/lib/navigation'
import {useDecisions, useProgress} from '@/lib/page-data'

export const Route = createFileRoute('/_tabs/cleanup/$section/free')({
  beforeLoad: ({context, params}) => {
    if (context.page.seen.offer === 'refused') throw redirect({to: '/cleanup/$section', params: {section: params.section}, search: true, replace: true})
  },
  component: Free,
})

function Free() {
  const {progress} = useProgress()
  const {held} = useDecisions()
  const navigate = Route.useNavigate()
  const back = useBack()
  const {section} = Route.useParams()
  const exit = useDialogExit()
  const offer = freeOffer(progress)
  const toSection = () => navigate({to: '/cleanup/$section', params: true, search: true, replace: true})
  const free = () => {
    held('free')
    exit.leave(toSection)
  }
  if (!progress) return null
  return (
    <FreeDialog
      progress={progress}
      open={exit.open && offer === 'offered'}
      onOpenChange={open => open || exit.leave(() => back({to: '/cleanup/$section', params: {section}, search: true}))}
      onClosed={() => (exit.then ?? toSection)()}
      onFree={free}
    />
  )
}

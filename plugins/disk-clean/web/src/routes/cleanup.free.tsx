import {createFileRoute, Navigate, redirect} from '@tanstack/react-router'
import {FreeDialog} from '@/components/free-dialog'
import {freeOffer} from '@/lib/cleanup'
import {useBack} from '@/lib/navigation'
import {useDecisions, useProgress} from '@/lib/page-data'
import {OpenSection} from './-open-section'

export const Route = createFileRoute('/cleanup/free')({
  beforeLoad: ({context}) => {
    if (context.page.seen.offer === 'refused') throw redirect({to: '/cleanup', search: true, replace: true})
  },
  component: Free,
})

function Free() {
  const {progress} = useProgress()
  const {held} = useDecisions()
  const navigate = Route.useNavigate()
  const back = useBack()
  const offer = freeOffer(progress)
  if (offer === 'refused') return <Navigate to="/cleanup" search replace />
  const free = () => {
    navigate({to: '/cleanup', search: true, replace: true})
    held('free')
  }
  return (
    <>
      <OpenSection section="" />
      {progress && <FreeDialog progress={progress} open={offer === 'offered'} onOpenChange={open => open || back({to: '/cleanup', search: true})} onFree={free} />}
    </>
  )
}

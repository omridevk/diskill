import {createFileRoute, redirect} from '@tanstack/react-router'
import {firstSectionNow} from '@/lib/page-data'
import {OpenSection} from './-open-section'

export const Route = createFileRoute('/_tabs/cleanup/')({
  beforeLoad: ({context}) => {
    const section = firstSectionNow(context.db)
    if (section) throw redirect({to: '/cleanup/$section', params: {section}, search: true, replace: true})
  },
  component: Scanning,
})

function Scanning() {
  return <OpenSection section="" />
}

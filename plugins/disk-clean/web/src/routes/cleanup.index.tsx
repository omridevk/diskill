import {createFileRoute, redirect} from '@tanstack/react-router'
import {firstSection} from '@/lib/data'
import {OpenSection} from './-open-section'

export const Route = createFileRoute('/cleanup/')({
  beforeLoad: ({context}) => {
    const section = firstSection(context.page.seen.scan.data.categories)
    if (section) throw redirect({to: '/cleanup/$section', params: {section}, search: true, replace: true})
  },
  component: Scanning,
})

function Scanning() {
  return <OpenSection section="" />
}

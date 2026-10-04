import {createFileRoute} from '@tanstack/react-router'
import {OpenSection} from './-open-section'

export const Route = createFileRoute('/cleanup/')({
  component: FirstSection,
})

function FirstSection() {
  return <OpenSection section="" />
}

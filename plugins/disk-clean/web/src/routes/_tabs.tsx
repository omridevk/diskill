import {createFileRoute} from '@tanstack/react-router'
import {Shell} from '@/components/shell'
import {PageContext, usePageState} from '@/lib/page-data'

export const Route = createFileRoute('/_tabs')({
  component: Tabs,
})

function Tabs() {
  const page = Route.useRouteContext({select: context => context.page})
  return (
    <PageContext value={usePageState(page)}>
      <Shell />
    </PageContext>
  )
}

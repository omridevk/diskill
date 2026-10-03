import {createFileRoute} from '@tanstack/react-router'
import {Insights} from '@/components/insights'
import {Streamed, useApp} from '@/components/shell'

export const Route = createFileRoute('/insights')({
  component: InsightsTab,
})

function InsightsTab() {
  const {data} = useApp()
  return (
    <Streamed>
      <Insights insights={data.insights} categories={data.categories} />
    </Streamed>
  )
}

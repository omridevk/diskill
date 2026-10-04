import {createFileRoute} from '@tanstack/react-router'
import {Insights} from '@/components/insights'
import {Streamed} from '@/components/streamed'
import {useScanData} from '@/lib/page-data'

export const Route = createFileRoute('/insights')({
  component: InsightsTab,
})

function InsightsTab() {
  const {insights, categories} = useScanData()
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Streamed>
        <Insights insights={insights} categories={categories} />
      </Streamed>
    </div>
  )
}

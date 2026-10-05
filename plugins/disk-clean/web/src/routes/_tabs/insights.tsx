import {createFileRoute} from '@tanstack/react-router'
import {Insights} from '@/components/insights'
import {Streamed} from '@/components/streamed'

export const Route = createFileRoute('/_tabs/insights')({
  component: InsightsTab,
})

function InsightsTab() {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Streamed>
        <Insights />
      </Streamed>
    </div>
  )
}

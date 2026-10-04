import {getRouteApi} from '@tanstack/react-router'
import {SectionDetail} from '@/components/cleanup'

const cleanup = getRouteApi('/cleanup')

export function OpenSection({section}: {section: string}) {
  const view = cleanup.useSearch({select: search => search.view})
  return view === 'list' ? <SectionDetail section={section} /> : null
}

import {createFileRoute, Link, notFound, Outlet} from '@tanstack/react-router'
import {OpenSection} from './-open-section'

export const Route = createFileRoute('/cleanup/$section')({
  beforeLoad: ({context, params}) => {
    const {scan} = context.page.seen
    if (scan.done && !scan.data.categories.some(c => c.id === params.section)) throw notFound()
  },
  component: Section,
  notFoundComponent: MissingSection,
})

function Section() {
  const {section} = Route.useParams()
  return (
    <>
      <OpenSection section={section} />
      <Outlet />
    </>
  )
}

function MissingSection() {
  const {section} = Route.useParams()
  return (
    <div className="flex grow flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
      <p>There is no section called “{section}” in this scan.</p>
      <Link to="/cleanup" search className="text-foreground underline underline-offset-4">
        Show the first section
      </Link>
    </div>
  )
}

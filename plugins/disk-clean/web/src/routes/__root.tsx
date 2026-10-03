import {createRootRouteWithContext, Link, stripSearchParams} from '@tanstack/react-router'
import {Shell} from '@/components/shell'
import type {Loaded} from '@/lib/data'
import {ROOT_DEFAULTS, rootSearch} from '@/lib/search'

export const Route = createRootRouteWithContext<{loaded: Loaded}>()({
  validateSearch: rootSearch,
  search: {middlewares: [stripSearchParams(ROOT_DEFAULTS)]},
  component: Root,
  notFoundComponent: NotFound,
})

function Root() {
  const loaded = Route.useRouteContext({select: context => context.loaded})
  return <Shell loaded={loaded} />
}

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
      <p>There is no page at this address.</p>
      <Link to="/cleanup" className="text-foreground underline underline-offset-4">
        Go to Cleanup
      </Link>
    </div>
  )
}

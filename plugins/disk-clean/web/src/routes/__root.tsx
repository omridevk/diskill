import {createRootRouteWithContext, Link, retainSearchParams, stripSearchParams, useRouter, type ErrorComponentProps} from '@tanstack/react-router'
import {Shell} from '@/components/shell'
import {Button} from '@/components/ui/button'
import {messageOf, PageContext, usePageState, type Page} from '@/lib/page-data'
import {ROOT_DEFAULTS, rootSearch} from '@/lib/search'

export const Route = createRootRouteWithContext<{page: Page}>()({
  validateSearch: rootSearch,
  search: {middlewares: [retainSearchParams(['add', 'drop']), stripSearchParams(ROOT_DEFAULTS)]},
  component: Root,
  notFoundComponent: NotFound,
  errorComponent: Broken,
})

function Root() {
  const page = Route.useRouteContext({select: context => context.page})
  const state = usePageState(page)
  return (
    <PageContext value={state}>
      <Shell />
    </PageContext>
  )
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

function Broken({error}: ErrorComponentProps) {
  const router = useRouter()
  return (
    <div role="alert" className="flex min-h-svh flex-col items-center justify-center gap-3 p-10 text-center text-sm">
      <h1 className="text-lg font-semibold">This page hit a problem</h1>
      <p className="max-w-lg text-muted-foreground">Nothing was deleted. {messageOf(error)}</p>
      <Button variant="outline" onClick={() => router.invalidate()}>
        Try again
      </Button>
    </div>
  )
}

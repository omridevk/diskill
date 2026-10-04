import {createRouter, RouterProvider, type RouterHistory} from '@tanstack/react-router'
import {useState} from 'react'
import type {Loaded} from './lib/data'
import {createPage} from './lib/page-data'
import {createTabMemory} from './lib/tab-memory'
import {routeTree} from './routeTree.gen'

function createAppRouter(loaded: Loaded, history: RouterHistory) {
  const tabs = createTabMemory()
  const router = createRouter({routeTree, history, context: {page: createPage(loaded), tabs}})
  router.subscribe('onResolved', ({toLocation}) => {
    const {matches} = router.state
    const layout = matches.findIndex(match => match.routeId === '/_tabs')
    const tab = layout < 0 ? undefined : matches[layout + 1]
    if (tab) tabs.remember(tab.routeId, toLocation.href)
  })
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}

export function App({loaded, history}: {loaded: Loaded; history: RouterHistory}) {
  const [router] = useState(() => createAppRouter(loaded, history))
  return <RouterProvider router={router} />
}

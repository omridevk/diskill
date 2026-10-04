import {createRouter, RouterProvider, type RouterHistory} from '@tanstack/react-router'
import {useState} from 'react'
import type {Loaded} from './lib/data'
import {createPage} from './lib/page-data'
import {routeTree} from './routeTree.gen'

function createAppRouter(loaded: Loaded, history: RouterHistory) {
  return createRouter({routeTree, history, context: {page: createPage(loaded)}})
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

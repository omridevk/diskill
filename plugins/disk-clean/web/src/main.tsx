import './index.css'
import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {App} from './App'
import {load} from './lib/data'

const root = document.getElementById('root')
if (root) {
  load().then(loaded =>
    createRoot(root).render(
      <StrictMode>
        <App loaded={loaded} />
      </StrictMode>,
    ),
  )
}

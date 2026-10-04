import {fileURLToPath} from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import {tanstackRouter} from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import {playwright} from '@vitest/browser-playwright'
import {defineConfig} from 'vitest/config'
import {viteSingleFile} from 'vite-plugin-singlefile'

const review = process.env.DISK_CLEAN_REVIEW_URL
const retina = playwright({contextOptions: {deviceScaleFactor: 2}})
const VIEWPORT = {width: 1440, height: 960}
const CHROMIUM = {browser: 'chromium' as const, viewport: VIEWPORT}
const FIREFOX = {browser: 'firefox' as const, viewport: VIEWPORT}
const FILM = ['src/film.test.tsx']
const ROUTER = ['src/router.test.tsx']
const HOLD = ['src/hold.test.tsx']
const SCANNING = ['src/scanning.test.tsx']

interface Instance {
  browser: 'chromium' | 'firefox'
  viewport: {width: number; height: number}
  name?: string
  include?: string[]
  provider?: typeof retina
}

function inBrowsers(project: string, instances: Instance[]) {
  return {
    enabled: true,
    headless: true,
    provider: playwright(),
    instances: instances.map(instance => ({...instance, name: `${project} ${instance.name ?? instance.browser}`})),
  }
}

export default defineConfig({
  plugins: [tanstackRouter({target: 'react'}), react(), tailwindcss(), viteSingleFile()],
  resolve: {alias: {'@': fileURLToPath(new URL('./src', import.meta.url))}},
  server: {proxy: review ? {'/preview': review, '/decide': review, '/events': review, '/undo': review, '/free': review} : undefined},
  optimizeDeps: {
    include: [
      '@base-ui/react/popover',
      'gsap',
      'gsap/CustomEase',
      'gsap/DrawSVGPlugin',
      'gsap/Flip',
      'gsap/SplitText',
      '@gsap/react',
      '@tanstack/db',
      '@tanstack/react-db',
      '@tanstack/react-store',
      '@tanstack/react-router',
      '@tanstack/react-table',
      '@tanstack/react-virtual',
    ],
  },
  build: {outDir: '../cli/assets', emptyOutDir: false},
  test: {
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'app',
          include: ['src/**/*.test.tsx'],
          exclude: ['src/perf.test.tsx'],
          browser: inBrowsers('app', [
            CHROMIUM,
            {...FIREFOX, include: [...FILM, ...ROUTER, ...HOLD, ...SCANNING], provider: retina},
            {browser: 'chromium', name: 'chromium-retina', viewport: {width: 1280, height: 900}, include: FILM, provider: retina},
          ]),
        },
      },
      {
        extends: true,
        mode: 'production',
        define: {'process.env.NODE_ENV': JSON.stringify('production')},
        cacheDir: 'node_modules/.vite-perf',
        server: {headers: {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'}},
        resolve: {alias: [{find: /^react-dom\/client$/, replacement: 'react-dom/profiling'}]},
        oxc: {jsx: {runtime: 'automatic', development: false}},
        test: {name: 'perf', include: ['src/perf.test.tsx'], browser: inBrowsers('perf', [CHROMIUM, FIREFOX])},
      },
    ],
  },
})

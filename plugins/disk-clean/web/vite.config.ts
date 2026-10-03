import {fileURLToPath} from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import {playwright} from '@vitest/browser-playwright'
import {defineConfig} from 'vitest/config'
import {viteSingleFile} from 'vite-plugin-singlefile'

const review = process.env.DISK_CLEAN_REVIEW_URL
const VIEWPORT = {width: 1440, height: 960}
const CHROMIUM = {browser: 'chromium' as const, viewport: VIEWPORT}
const FIREFOX = {browser: 'firefox' as const, viewport: VIEWPORT}

function inBrowsers(project: string, instances: ({browser: 'chromium' | 'firefox'; viewport: typeof VIEWPORT; include?: string[]})[]) {
  return {enabled: true, headless: true, provider: playwright(), instances: instances.map(instance => ({...instance, name: `${project} ${instance.browser}`}))}
}

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {alias: {'@': fileURLToPath(new URL('./src', import.meta.url))}},
  server: {proxy: review ? {'/preview': review, '/decide': review, '/events': review} : undefined},
  optimizeDeps: {include: ['gsap', 'gsap/CustomEase', 'gsap/DrawSVGPlugin', 'gsap/Flip', 'gsap/SplitText', '@gsap/react', '@tanstack/react-store', '@tanstack/react-table', '@tanstack/react-virtual']},
  build: {outDir: '../cli/assets', emptyOutDir: false},
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'app',
          include: ['src/**/*.test.tsx'],
          exclude: ['src/perf.test.tsx'],
          browser: inBrowsers('app', [CHROMIUM, {...FIREFOX, include: ['src/film.test.tsx']}]),
        },
      },
      {
        extends: true,
        mode: 'production',
        define: {'process.env.NODE_ENV': JSON.stringify('production')},
        cacheDir: 'node_modules/.vite-perf',
        oxc: {jsx: {runtime: 'automatic', development: false}},
        test: {name: 'perf', include: ['src/perf.test.tsx'], browser: inBrowsers('perf', [CHROMIUM, FIREFOX])},
      },
    ],
  },
})

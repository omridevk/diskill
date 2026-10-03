import {fileURLToPath} from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import {playwright} from '@vitest/browser-playwright'
import {defineConfig} from 'vitest/config'
import {viteSingleFile} from 'vite-plugin-singlefile'

const review = process.env.DISK_CLEAN_REVIEW_URL
const retina = playwright({contextOptions: {deviceScaleFactor: 2}})

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {alias: {'@': fileURLToPath(new URL('./src', import.meta.url))}},
  server: {proxy: review ? {'/preview': review, '/decide': review, '/events': review} : undefined},
  optimizeDeps: {include: ['@base-ui/react/popover', 'gsap', 'gsap/CustomEase', 'gsap/DrawSVGPlugin', 'gsap/Flip', 'gsap/SplitText', '@gsap/react']},
  build: {outDir: '../cli/assets', emptyOutDir: false},
  test: {
    include: ['src/**/*.test.tsx'],
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [
        {browser: 'chromium', viewport: {width: 1440, height: 960}},
        {browser: 'firefox', viewport: {width: 1440, height: 960}, include: ['src/film.test.tsx'], provider: retina},
        {browser: 'chromium', name: 'chromium-retina', viewport: {width: 1280, height: 900}, include: ['src/film.test.tsx'], provider: retina},
      ],
    },
  },
})

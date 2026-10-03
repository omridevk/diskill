import {fileURLToPath} from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import {playwright} from '@vitest/browser-playwright'
import {defineConfig} from 'vitest/config'
import {viteSingleFile} from 'vite-plugin-singlefile'

const review = process.env.DISK_CLEAN_REVIEW_URL

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {alias: {'@': fileURLToPath(new URL('./src', import.meta.url))}},
  server: {proxy: review ? {'/preview': review, '/decide': review, '/events': review} : undefined},
  optimizeDeps: {include: ['gsap', 'gsap/CustomEase', 'gsap/DrawSVGPlugin', 'gsap/Flip', 'gsap/SplitText', '@gsap/react']},
  build: {outDir: '../cli/assets', emptyOutDir: false},
  test: {
    include: ['src/**/*.test.tsx'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [
        {browser: 'chromium', viewport: {width: 1440, height: 960}},
        {browser: 'firefox', viewport: {width: 1440, height: 960}, include: ['src/film.test.tsx']},
      ],
    },
  },
})

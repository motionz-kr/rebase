import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = dirname(fileURLToPath(import.meta.url))
const rootPackage = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8')) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the built renderer loads under Electron's file://
  // protocol (loadFile). Absolute '/assets/…' paths 404 there and blank the app.
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPackage.version),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
})


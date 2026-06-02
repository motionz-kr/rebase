import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the built renderer loads under Electron's file://
  // protocol (loadFile). Absolute '/assets/…' paths 404 there and blank the app.
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
})



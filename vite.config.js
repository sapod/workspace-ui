import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/global': {
        target: 'http://localhost:4096',
        changeOrigin: true,
      },
      '/session': {
        target: 'http://localhost:4096',
        changeOrigin: true,
      },
      '/path': {
        target: 'http://localhost:4096',
        changeOrigin: true,
      },
      '/file': {
        target: 'http://localhost:4096',
        changeOrigin: true,
      },
    },
  },
})
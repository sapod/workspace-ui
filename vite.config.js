import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
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
        target: 'http://localhost:4097',
        changeOrigin: true,
      },
      '/files': {
        target: 'http://localhost:4097',
        changeOrigin: true,
      },
    },
  },
})
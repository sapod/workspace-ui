import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function readServiceInfo() {
  try {
    const file = join(homedir(), '.local', 'state', 'opencode', 'service.json')
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const service = readServiceInfo()

  const target = (env.OPENCODE_SERVER_URL || service.url || 'http://localhost:4096').replace(/\/$/, '')
  const password = env.OPENCODE_PASSWORD || service.password || ''
  const authorization = password
    ? 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
    : undefined

  const opencodeProxy = {
    target,
    changeOrigin: true,
    ...(authorization ? { headers: { Authorization: authorization } } : {}),
  }

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      proxy: {
        '/api': opencodeProxy,
        '/path': {
          target: 'http://localhost:4097',
          changeOrigin: true,
        },
        '/files': {
          target: 'http://localhost:4097',
          changeOrigin: true,
        },
        '/file': {
          target: 'http://localhost:4097',
          changeOrigin: true,
        },
        '/git': {
          target: 'http://localhost:4097',
          changeOrigin: true,
        },
      },
    },
  }
})

#!/usr/bin/env node
/**
 * opencode-web  —  server.js
 *
 * 1. Serves ui.html (the React frontend)
 * 2. Proxies /api/* → opencode HTTP API  (handles CORS + SSE timeouts)
 * 3. Optional Basic Auth
 *
 * Usage:
 *   node server.js [--port 7080] [--opencode http://localhost:4096] [--password secret] [--model anthropic/claude-sonnet-4-5]
 * Env vars: PORT, OPENCODE, PASSWORD, MODEL
 */

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const http = require('http');
const https = require('https');
const fs   = require('fs');

const argv = process.argv.slice(2);
function arg(flag, env, fallback) {
  const i = argv.indexOf(flag);
  return (i !== -1 && argv[i + 1]) ? argv[i + 1] : (process.env[env] || fallback);
}

const PORT     = parseInt(arg('--port',     'PORT',     '7080'), 10);
const OC_URL   = arg('--opencode', 'OPENCODE', 'http://localhost:4096');
const PASSWORD = arg('--password', 'PASSWORD', '');
const MODEL    = arg('--model',    'MODEL',    'opencode/big-pickle');
const UI       = __dirname + '/ui.html';

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, OC_URL);
    const headers = { 'Content-Type': 'application/json' };
    if (PASSWORD) {
      headers['Authorization'] = 'Basic ' + Buffer.from('opencode:' + PASSWORD).toString('base64');
    }
    const req = (url.protocol === 'https:' ? https : http).request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function setModel() {
  if (!MODEL || MODEL === 'default') return;
  try {
    const [providerID, modelID] = MODEL.includes('/') ? MODEL.split('/') : ['opencode', MODEL];
    await httpRequest('PATCH', '/config', { model: { providerID, modelID } });
    console.log(`  Model:  ${MODEL} (set as default)\n`);
  } catch (e) {
    console.error('  Warning: could not set default model:', e.message);
  }
}

console.log(`\n  ◈  opencode-web\n  ─────────────────────────────\n  UI:       http://0.0.0.0:${PORT}\n  Proxying: ${OC_URL}\n  Auth:     ${PASSWORD ? 'enabled' : 'disabled'}\n  ─────────────────────────────\n`);

if (!fs.existsSync(UI)) { console.error('ui.html not found at', UI); process.exit(1); }

const app = express();

// ── Basic Auth ──────────────────────────────────────────────
if (PASSWORD) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Basic ')) return deny(res);
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (pass !== PASSWORD) return deny(res);
    next();
  });
  function deny(res) {
    res.set('WWW-Authenticate', 'Basic realm="opencode-web"');
    res.status(401).send('Unauthorized');
  }
}

// ── Proxy /api/* and /v1/* and /models → opencode ─────────────────
// Important: selfHandleResponse:false so SSE streams pass through intact

app.use('/api', createProxyMiddleware({
  target: OC_URL,
  changeOrigin: true,
  pathRewrite: { '^/api': '' },
  selfHandleResponse: false,
  on: { error: (err, req, res) => {
    console.error('[proxy]', req.method, req.url, err.message);
    if (!res.headersSent) res.status(502).json({ error: 'opencode unreachable', detail: err.message });
  }},
}));

app.use('/models', createProxyMiddleware({
  target: OC_URL,
  changeOrigin: true,
  selfHandleResponse: false,
  on: { error: (err, req, res) => {
    console.error('[proxy]', req.method, req.url, err.message);
    if (!res.headersSent) res.status(502).json({ error: 'opencode unreachable', detail: err.message });
  }},
}));

app.use('/v1', createProxyMiddleware({
  target: OC_URL,
  changeOrigin: true,
  selfHandleResponse: false,
  on: { error: (err, req, res) => {
    console.error('[proxy]', req.method, req.url, err.message);
    if (!res.headersSent) res.status(502).json({ error: 'opencode unreachable', detail: err.message });
  }},
}));

// ── Serve React UI ──────────────────────────────────────────
app.get('/{*path}', (_req, res) => res.sendFile(UI));

// ── Start ───────────────────────────────────────────────────
const server = http.createServer(app);
server.timeout = 0;
server.keepAliveTimeout = 0;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`  ✓ Ready → http://<your-tailscale-ip>:${PORT}\n`);
  await setModel();
});

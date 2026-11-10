import express from 'express';
import cors from 'cors';
import { readdirSync, statSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { parseArgs } from 'util';
import { execSync, spawn } from 'child_process';

const IMAGE_EXTENSIONS = new Set(['png', 'svg', 'webp']);

function isImageFile(file) {
  const ext = file.split('.').pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

const app = express();
app.use(cors());

const { values } = parseArgs({
  options: {
    workdir: { type: 'string', short: 'w', default: process.cwd() },
  },
  strict: false,
});

const WORKSPACE = values.workdir || process.env.WORKDIR || process.cwd();

app.get('/path', (req, res) => {
  res.json({ path: WORKSPACE, cwd: WORKSPACE, home: homedir() });
});

app.get('/files', (req, res) => {
  let p = req.query.path || WORKSPACE;
  try {
    const entries = readdirSync(p).map(name => {
      const full = join(p, name);
      const stats = statSync(full);
      return {
        name,
        path: join(p, name),
        isDirectory: stats.isDirectory(),
      };
    });
    res.json(entries);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.use(express.json({ limit: '10mb' }));

app.get('/file', async (req, res) => {
  let p = req.query.path || WORKSPACE;
  try {
    const content = await fs.readFile(p, 'utf8');
    res.json({ content });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/file', async (req, res) => {
  let p = req.body.path || WORKSPACE;
  try {
    await fs.writeFile(p, req.body.content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function gitStatus(p, res) {
  if (!p || p === WORKSPACE) {
    return res.json([]);
  }
  const output = execSync(`git -C "${p}" status --porcelain -uall`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/zsh' });
  if (!output.trim()) {
    return res.json([]);
  }
  const filesList = output.split('\n').filter(Boolean).map(line => {
    const status = line.slice(0, 2);
    const filePath = line.slice(3);
    const isUnversioned = status.includes('?');
    return {
      path: filePath,
      status: isUnversioned ? 'U' : (status.trim() || 'modified'),
      isNew: status.includes('A'),
      isModified: status.includes('M'),
      isDeleted: status.includes('D'),
      isUnversioned,
    };
  });
  return res.json(filesList);
}

function gitDiff(p, file, res) {
  if (!file || !p || p === WORKSPACE) {
    return res.status(400).json({ error: 'file and path parameters required' });
  }
  const isImage = isImageFile(file);
  let oldContent = '';
  let newContent = '';
  try {
    const gitContent = execSync(`git -C "${p}" show HEAD:"${file}"`, { encoding: null, shell: '/bin/zsh' });
    oldContent = isImage ? gitContent.toString('base64') : gitContent.toString('utf-8');
  } catch {
    oldContent = '';
  }
  try {
    const fileContent = readFileSync(join(p, file));
    newContent = isImage ? fileContent.toString('base64') : fileContent.toString('utf-8');
  } catch {
    newContent = '';
  }
  return res.json({ oldContent, newContent, isImage: isImage || false });
}

function gitCommit(p, files, message, res) {
  if (!p || !Array.isArray(files) || !message) {
    return res.status(400).json({ error: 'path, files array, and message are required' });
  }
  const fileList = files.map(f => `"${f}"`).join(' ');
  execSync(`git -C "${p}" add ${fileList}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/zsh' });
  execSync(`git -C "${p}" commit -m "${message}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/zsh' });
  return res.json({ success: true });
}

function gitRollback(p, files, res) {
  if (!p || !Array.isArray(files)) {
    return res.status(400).json({ error: 'path and files array are required' });
  }
  for (const f of files) {
    execSync(`git -C "${p}" checkout -- "${f}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/zsh' });
  }
  return res.json({ success: true });
}

function gitLog(p, limit = 20, res) {
  if (!p) {
    return res.status(400).json({ error: 'path is required' });
  }
  const output = execSync(`git -C "${p}" log --oneline -n ${limit}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/zsh' });
  const commits = output.split('\n').filter(Boolean).map(line => {
    const match = line.match(/^([a-f0-9]+)\s+(.*)$/);
    return match ? { hash: match[1], message: match[2] } : { hash: '', message: line };
  });
  return res.json(commits);
}

const runningScripts = new Map();
const scriptLastRuns = new Map();
const MAX_SCRIPT_OUTPUT = 20000;
const SCRIPT_LAST_RUN_TTL_MS = 24 * 60 * 60 * 1000;
const SCRIPT_TRACKED_RECONCILE_MS = 10 * 1000;

function scriptKey(p, name) {
  return `${p}::${name}`;
}

function appendOutput(buf, chunk) {
  const next = (buf || '') + String(chunk ?? '');
  if (next.length <= MAX_SCRIPT_OUTPUT) return next;
  return next.slice(next.length - MAX_SCRIPT_OUTPUT);
}

function pruneExpiredScriptLastRuns(now = Date.now()) {
  for (const [key, run] of scriptLastRuns.entries()) {
    const finishedAt = run?.finishedAt;
    if (!finishedAt || (now - finishedAt) > SCRIPT_LAST_RUN_TTL_MS) {
      scriptLastRuns.delete(key);
    }
  }
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reconcileTrackedScripts(now = Date.now()) {
  for (const [key, tracked] of runningScripts.entries()) {
    const child = tracked?.child;
    const active = child && child.exitCode == null && !child.killed;
    if (!active) {
      runningScripts.delete(key);
      continue;
    }
    if (isPidAlive(child.pid)) continue;

    const output = tracked.output || '';
    scriptLastRuns.set(key, {
      status: 'failed',
      code: null,
      signal: null,
      error: output || 'Process no longer running (state reconciled)',
      output,
      finishedAt: now,
    });
    runningScripts.delete(key);
  }
}

setInterval(() => {
  try { reconcileTrackedScripts(); } catch {}
  try { pruneExpiredScriptLastRuns(); } catch {}
}, SCRIPT_TRACKED_RECONCILE_MS).unref?.();

function readPackageScripts(p) {
  try {
    const raw = readFileSync(join(p, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  } catch {
    return null;
  }
}

function getProcessCwd(pid, cache) {
  if (cache && cache.has(pid)) return cache.get(pid);
  let cwd = null;
  try {
    const out = execSync(`lsof -a -p ${pid} -d cwd -Fn`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const line = out.split('\n').find(l => l.startsWith('n'));
    cwd = line ? line.slice(1) : null;
  } catch {
    cwd = null;
  }
  if (cache) cache.set(pid, cwd);
  return cwd;
}

function getActiveTrackedScriptsForPath(p) {
  const active = new Map();
  for (const [key, tracked] of runningScripts.entries()) {
    if (!key.startsWith(`${p}::`)) continue;
    if (tracked && tracked.child && tracked.child.exitCode == null && !tracked.child.killed) {
      active.set(key.slice(`${p}::`.length), tracked);
    } else {
      runningScripts.delete(key);
    }
  }
  return active;
}

function buildRunTokenMatchers(scriptNames) {
  return scriptNames.map(name => {
    const tokens = ['npm', 'pnpm', 'yarn', 'bun'].flatMap(runner => ([
      `${runner} run ${name} `,
      `${runner} run ${name}`,
      `${runner} run-script ${name} `,
      `${runner} run-script ${name}`,
    ]));
    return { name, tokens };
  });
}

function collectDescendants(rootPids, childrenByPpid) {
  const out = new Set();
  const stack = [...rootPids];
  while (stack.length) {
    const pid = stack.pop();
    if (!pid || out.has(pid)) continue;
    out.add(pid);
    const kids = childrenByPpid.get(pid);
    if (!kids) continue;
    for (const kid of kids) {
      if (!out.has(kid)) stack.push(kid);
    }
  }
  return out;
}

function getScriptsStatusList(p, scriptsObj) {
  pruneExpiredScriptLastRuns();
  const names = Object.keys(scriptsObj || {});
  const activeTracked = getActiveTrackedScriptsForPath(p);
  const result = new Map(names.map(n => [n, []]));
  const cwdCache = new Map();

  if (names.length === 0) {
    return [];
  }

  try {
    const out = execSync(`ps -axo pid=,ppid=,command=`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const processes = [];
    const childrenByPpid = new Map();

    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const cmd = m[3];
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      processes.push({ pid, ppid, cmd });
      if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, []);
      childrenByPpid.get(ppid).push(pid);
    }

    let ignoredPids = new Set();
    if (activeTracked.size > 0) {
      const roots = [...activeTracked.values()]
        .map(t => t?.child?.pid)
        .filter(pid => Number.isFinite(pid));
      // Ignore descendants of tool-tracked roots (child npm runs spawned by them),
      // but not the tracked roots themselves (handled explicitly per script).
      const all = collectDescendants(roots, childrenByPpid);
      for (const pid of roots) all.delete(pid);
      ignoredPids = all;
    }

    const matchers = buildRunTokenMatchers(names);
    for (const proc of processes) {
      if (ignoredPids.has(proc.pid)) continue;
      for (const matcher of matchers) {
        let matched = false;
        for (const token of matcher.tokens) {
          if (token.endsWith(' ')) {
            if (proc.cmd.includes(token)) { matched = true; break; }
          } else if (proc.cmd.endsWith(token) || proc.cmd.includes(`${token} `)) {
            matched = true; break;
          }
        }
        if (!matched) continue;
        const cwd = getProcessCwd(proc.pid, cwdCache);
        if (cwd === p) result.get(matcher.name).push(proc.pid);
      }
    }
  } catch {
    // Best-effort detection only; fall through with empty external results.
  }

  return names.map((name) => {
    const key = scriptKey(p, name);
    const lastRun = scriptLastRuns.get(key) || null;
    const tracked = runningScripts.get(key);
    if (tracked && tracked.child && tracked.child.exitCode == null && !tracked.child.killed) {
      return { name, command: scriptsObj[name], running: true, pids: [tracked.child.pid], source: 'tool', lastRun };
    }
    if (tracked) runningScripts.delete(key);

    const external = result.get(name) || [];
    if (external.length) return { name, command: scriptsObj[name], running: true, pids: external, source: 'external', lastRun };
    return { name, command: scriptsObj[name], running: false, pids: [], lastRun };
  });
}

function getSingleScriptStatus(p, name, scriptsObj = null) {
  const scripts = scriptsObj || readPackageScripts(p) || {};
  const list = getScriptsStatusList(p, { [name]: scripts[name] });
  return list[0] || { name, command: scripts[name], running: false, pids: [], lastRun: scriptLastRuns.get(scriptKey(p, name)) || null };
}

app.get('/scripts', (req, res) => {
  const p = req.query.path || WORKSPACE;
  const scripts = readPackageScripts(p);
  if (scripts == null) return res.status(400).json({ error: 'package.json not found or invalid' });
  res.json({ scripts: getScriptsStatusList(p, scripts) });
});

app.post('/scripts/start', (req, res) => {
  const { path: pRaw, name } = req.body || {};
  const p = pRaw || WORKSPACE;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  const scripts = readPackageScripts(p);
  if (!scripts || !(name in scripts)) return res.status(400).json({ error: 'script not found' });
  const status = getSingleScriptStatus(p, name, scripts);
  if (status.running) return res.json({ ok: true, alreadyRunning: true, ...status });

  const child = spawn('npm', ['run', name], {
    cwd: p,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const key = scriptKey(p, name);
  const tracked = { child, startedAt: Date.now(), output: '' };
  runningScripts.set(key, tracked);

  child.stdout?.on('data', (chunk) => { tracked.output = appendOutput(tracked.output, chunk); });
  child.stderr?.on('data', (chunk) => { tracked.output = appendOutput(tracked.output, chunk); });

  child.on('error', (err) => {
    tracked.output = appendOutput(tracked.output, `\n${err?.message || String(err)}`);
    scriptLastRuns.set(key, {
      status: 'failed',
      code: null,
      signal: null,
      error: err?.message || String(err),
      output: tracked.output || err?.message || String(err),
      finishedAt: Date.now(),
    });
    const cur = runningScripts.get(key);
    if (cur && cur.child === child) runningScripts.delete(key);
  });

  child.on('close', (code, signal) => {
    // If 'error' already recorded a failure, don't overwrite with a generic close state.
    const existing = scriptLastRuns.get(key);
    if (!(existing && existing.status === 'failed' && existing.finishedAt && existing.finishedAt >= tracked.startedAt && code == null && signal == null)) {
      const ok = code === 0;
      scriptLastRuns.set(key, {
        status: ok ? 'success' : 'failed',
        code: code ?? null,
        signal: signal ?? null,
        error: ok ? null : (tracked.output || `Exited with code ${code}${signal ? ` (signal ${signal})` : ''}`),
        output: tracked.output || '',
        finishedAt: Date.now(),
      });
    }
    const cur = runningScripts.get(key);
    if (cur && cur.child === child) runningScripts.delete(key);
  });

  child.unref();
  res.json({ ok: true, running: true, pids: [child.pid], source: 'tool' });
});

app.post('/scripts/stop', (req, res) => {
  const { path: pRaw, name } = req.body || {};
  const p = pRaw || WORKSPACE;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  const status = getSingleScriptStatus(p, name);
  if (!status.running) return res.json({ ok: true, running: false });

  for (const pid of status.pids) {
    try { process.kill(-pid, 'SIGTERM'); } catch {}
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  setTimeout(() => {
    for (const pid of status.pids) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }, 1500).unref?.();

  const key = scriptKey(p, name);
  // Keep tracked entry until process exit is observed so status can reflect "stopping".
  res.json({ ok: true, stopping: true });
});

app.post('/scripts/cleanup', (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
  const cleaned = new Set();
  for (const p of paths) {
    if (!p || typeof p !== 'string') continue;
    const prefix = `${p}::`;
    for (const key of [...scriptLastRuns.keys()]) {
      if (key.startsWith(prefix)) scriptLastRuns.delete(key);
    }
    for (const [key, tracked] of [...runningScripts.entries()]) {
      if (!key.startsWith(prefix)) continue;
      const active = tracked && tracked.child && tracked.child.exitCode == null && !tracked.child.killed;
      if (!active) runningScripts.delete(key);
    }
    cleaned.add(p);
  }
  res.json({ ok: true, cleaned: [...cleaned] });
});

app.all('/git/:action', (req, res) => {
  const { action } = req.params;
  const { path, file, files, message } = req.body;
  const p = path || WORKSPACE;

  try {
    switch (action) {
      case 'status': return gitStatus(p, res);
      case 'diff': return gitDiff(p, file, res);
      case 'commit': return gitCommit(p, files, message, res);
      case 'rollback': return gitRollback(p, files, res);
      case 'log': return gitLog(p, req.body.limit || 20, res);
      default: return res.status(404).json({ error: 'Unknown git action' });
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(4097, '0.0.0.0', () => {
  console.log('Server on http://0.0.0.0:4097');
});
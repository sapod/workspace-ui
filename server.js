import express from 'express';
import cors from 'cors';
import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import { execSync } from 'child_process';

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
  res.json({ path: WORKSPACE, cwd: WORKSPACE });
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

app.get('/git-status', (req, res) => {
  let p = req.query.path || WORKSPACE;
  if (!p || p === WORKSPACE) {
    return res.json([]);
  }
  try {
    const output = execSync(`git -C "${p}" status --porcelain`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/zsh' });
    if (!output.trim()) {
      return res.json([]);
    }
    const files = output.split('\n').filter(Boolean).map(line => {
      const status = line.slice(0, 2);
      const filePath = line.slice(3);
      return {
        path: filePath,
        status: status.trim() || 'modified',
        isNew: status.includes('?') || status.includes('A'),
        isModified: status.includes('M'),
        isDeleted: status.includes('D'),
      };
    });
    res.json(files);
  } catch (e) {
    console.error('git-status error:', e.message);
    res.json([]);
  }
});

app.get('/git-diff', (req, res) => {
  let p = req.query.path || WORKSPACE;
  let file = req.query.file;
  if (!file || !p || p === WORKSPACE) {
    return res.status(400).json({ error: 'file and path parameters required' });
  }
  try {
    let oldContent = '';
    let newContent = '';
    try {
      oldContent = execSync(`git -C "${p}" show HEAD:"${file}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/zsh' });
    } catch {
      oldContent = '';
    }
    try {
      newContent = readFileSync(join(p, file), 'utf-8');
    } catch {
      newContent = '';
    }
    res.json({ oldContent, newContent });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(4097, '0.0.0.0', () => {
  console.log('Server on http://0.0.0.0:4097');
});
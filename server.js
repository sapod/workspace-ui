import express from 'express';
import cors from 'cors';
import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import { execSync } from 'child_process';

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

app.use(express.json());

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
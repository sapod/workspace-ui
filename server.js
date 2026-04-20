import express from 'express';
import cors from 'cors';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';

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

app.listen(4097, '0.0.0.0', () => {
  console.log('Server on http://0.0.0.0:4097');
});
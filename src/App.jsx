import { useState, useEffect, useRef } from 'react';
import oc from './services/opencode';
import { git } from './services/git';
import { GitDiff } from './components/GitDiff';
import './App.css';

const STORE = 'oc_projects_v1';
const SESSION_STORE = 'oc_open_session_v1';

function loadProjects() {
  try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; }
}
function saveProjects(p) {
  try { localStorage.setItem(STORE, JSON.stringify(p)); } catch {}
}
function loadOpenSession() {
  try { return localStorage.getItem(SESSION_STORE) || null; } catch { return null; }
}
function saveOpenSession(id) {
  try { localStorage.setItem(SESSION_STORE, id || ''); } catch {}
}

const SLASHES = [
  { cmd: '/new', desc: 'New session in this project' },
  { cmd: '/sessions', desc: 'List sessions' },
  { cmd: '/models', desc: 'Show available models' },
  { cmd: '/fork', desc: 'Fork current session' },
  { cmd: '/clear', desc: 'Clear context' },
  { cmd: '/export', desc: 'Export messages as JSON' },
];

function toolIcon(n = '') {
  n = n.toLowerCase();
  if (n.includes('read') || n.includes('file')) return '📄';
  if (n.includes('write') || n.includes('edit') || n.includes('patch')) return '✏️';
  if (n.includes('bash') || n.includes('shell') || n.includes('exec')) return '⚡';
  if (n.includes('search') || n.includes('grep')) return '🔍';
  if (n.includes('list') || n.includes('ls')) return '📂';
  if (n.includes('web') || n.includes('fetch')) return '🌐';
  return '⚙️';
}

function InlineText({ text }) {
  const html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-wrap">
      <div className="code-hdr">
        <span className="code-lang">{lang || 'code'}</span>
        <button className="copy-btn" onClick={() => {
          navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}>{copied ? 'copied!' : 'copy'}</button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function RichText({ text, className }) {
  const parts = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ t: 'inline', v: text.slice(last, m.index) });
    parts.push({ t: 'code', lang: m[1], v: m[2].trim() });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: 'inline', v: text.slice(last) });
  return (
    <div className={className}>
      {parts.map((p, i) => p.t === 'code'
        ? <CodeBlock key={i} lang={p.lang} code={p.v} />
        : <InlineText key={i} text={p.v} />)}
    </div>
  );
}

function ToolBlock({ inv }) {
  const [open, setOpen] = useState(false);
  const isRun = inv.state === 'call';
  const isEdit = (inv.toolName || '').toLowerCase().includes('edit');
  const editArgs = isEdit && inv.args?.filePath ? inv.args : null;
  const lines = [];
  if (inv.args) lines.push('INPUT:\n' + JSON.stringify(inv.args, null, 2));
  if (inv.result != null) {
    const r = typeof inv.result === 'string' ? inv.result : JSON.stringify(inv.result, null, 2);
    lines.push('OUTPUT:\n' + r.slice(0, 2000) + (r.length > 2000 ? '\n…' : ''));
  }
  return (
    <div className="tool-wrap">
      <div className="tool-hdr" onClick={() => setOpen(o => !o)}>
        <span>{toolIcon(inv.toolName)}</span>
        <span className="tool-label">{inv.toolName || 'tool'}</span>
        <span className={`tool-st ${isRun ? 'run' : 'ok'}`}>{isRun ? '● running' : '✓ done'}</span>
      </div>
      {open && (
        <div className="tool-body">
          {editArgs ? (
            <GitDiff
              filePath={editArgs.filePath}
              oldString={editArgs.oldString}
              newString={editArgs.newString}
            />
          ) : (
            <pre>{lines.join('\n\n') || '(no details)'}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg }) {
  const role = msg?.info?.role ?? msg?.role;
  const parts = msg?.parts ?? [];

  if (role === 'user') {
    const text = parts.find(p => p.type === 'text')?.text ?? '';
    if (!text) return null;
    return (
      <div className="msg is-user">
        <div className="msg-who who-u">You</div>
        <RichText text={text} className="bub-u" />
      </div>
    );
  }

  if (role === 'system') {
    const text = parts.find(p => p.type === 'text')?.text ?? '';
    if (!text) return null;
    return (
      <div className="msg is-system">
        <RichText text={text} className="bub-sys" />
      </div>
    );
  }

  if (role === 'assistant') {
    const isAborted = msg?.info?.error?.name === 'MessageAbortedError';
    return (
      <div className="msg">
        <div className="msg-who who-ai">opencode {isAborted && <span className="msg-aborted">(aborted)</span>}</div>
        {isAborted ? null : parts.map((p, i) => {
          if (p.type === 'text') {
            if (!p.text) return null;
            return <RichText key={i} text={p.text} className="bub-ai" />;
          }
          if (p.type === 'reasoning') {
            if (!p.text) return null;
            return <div key={i} className="reasoning">{p.text}</div>;
          }
          if (p.type === 'tool') return <ToolBlock key={i} inv={{ toolName: p.tool, result: p.state?.output, args: p.state?.input }} />;
          if (p.type === 'tool-invocation') return <ToolBlock key={i} inv={p.toolInvocation || {}} />;
          if (p.type === 'step-start' || p.type === 'step-finish') return null;
          return null;
        })}
      </div>
    );
  }
  return null;
}

function useToast() {
  const [state, setState] = useState({ msg: '', show: false });
  const t = useRef();
  function toast(msg, dur = 2400) {
    setState({ msg, show: true });
    clearTimeout(t.current);
    t.current = setTimeout(() => setState(s => ({ ...s, show: false })), dur);
  }
  const el = <div className={`toast${state.show ? ' show' : ''}`}>{state.msg}</div>;
  return { toast, toastEl: el };
}

function SlashMenu({ query, selIdx, onSelect }) {
  const hits = SLASHES.filter(s => s.cmd.startsWith(query));
  if (!hits.length) return null;
  return (
    <div className="slash-pop">
      {hits.map((s, i) => (
        <div key={s.cmd} className={`sl-row${i === selIdx ? ' sel' : ''}`} onClick={() => onSelect(s.cmd)}>
          <span className="sl-cmd">{s.cmd}</span>
          <span className="sl-desc">{s.desc}</span>
        </div>
      ))}
    </div>
  );
}

function MessageInput({ onSend, disabled, selectedModel }) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [hist, setHist] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [slashQ, setSlashQ] = useState('');
  const [slashSel, setSlashSel] = useState(0);
  const ta = useRef();

  function resize() {
    if (!ta.current) return;
    ta.current.style.height = 'auto';
    ta.current.style.height = Math.min(ta.current.scrollHeight, 150) + 'px';
  }

  function onChange(e) {
    const v = e.target.value;
    setText(v);
    resize();
    const word = v.split('\n')[0].split(' ')[0];
    if (v.startsWith('/') && !v.includes(' ') && v.length > 0) {
      setSlashQ(word);
      setSlashSel(0);
    } else {
      setSlashQ('');
    }
  }

  function onKey(e) {
    const hits = SLASHES.filter(s => s.cmd.startsWith(slashQ));
    if (slashQ && hits.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel(i => (i + 1) % hits.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel(i => (i - 1 + hits.length) % hits.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); doSelect(hits[slashSel].cmd); return; }
      if (e.key === 'Escape') { setSlashQ(''); return; }
    }
    if (e.key === 'ArrowUp' && ta.current?.selectionStart === 0 && hist.length) {
      e.preventDefault();
      const ni = Math.min(histIdx + 1, hist.length - 1);
      setHistIdx(ni);
      setText(hist[hist.length - 1 - ni]);
      return;
    }
    if (e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault();
      const ni = histIdx - 1;
      setHistIdx(ni);
      setText(ni < 0 ? '' : hist[hist.length - 1 - ni]);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  function doSelect(cmd) { setText(''); setSlashQ(''); onSend({ slash: cmd }); }

  function submit() {
    const v = text.trim();
    if (!v || disabled) return;
    if (v.startsWith('/')) {
      const w = v.split(' ')[0];
      const h = SLASHES.find(s => s.cmd === w);
      if (h) { setText(''); setSlashQ(''); onSend({ slash: w }); return; }
    }
    setHist(prev => [...prev.filter(x => x !== v), v]);
    setHistIdx(-1);
    setText('');
    setSlashQ('');
    setTimeout(resize, 0);
    onSend({ text: v });
  }

  return (
    <div className="inp-area">
      <div className="inp-rel">
        {slashQ && <SlashMenu query={slashQ} selIdx={slashSel} onSelect={doSelect} />}
        <div className={`inp-shell${focused ? ' focused' : ''}`}>
          <textarea ref={ta} className="msg-ta" rows={1}
            placeholder="Message opencode… (/ for commands)"
            value={text} onChange={onChange} onKeyDown={onKey}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
          <div className="inp-foot">
            <span className="inp-hint"><kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline · <kbd>↑</kbd> history</span>
            {selectedModel && <span className="inp-model">{selectedModel.name}</span>}
            <button className="send-btn" disabled={disabled || !text.trim()} onClick={submit}>Send ↵</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Thread({ messages, thinking, contextPath }) {
  const bot = useRef();
  useEffect(() => { bot.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, thinking]);

  if (messages === null) {
    return (
      <div className="thread">
        <div className="empty">
          <div className="empty-orb">◈</div>
          <div className="empty-h">No session open</div>
          <div className="empty-p">Select a project and session from the menu, or create a new one.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="thread">
      {contextPath && (
        <div className="ctx-note">
          ⚙ Working directory: <code>{contextPath}</code>
        </div>
      )}
      {messages.length === 0 && !thinking && (
        <div className="empty">
          <div className="empty-orb">◈</div>
          <div className="empty-h">New session</div>
          <div className="empty-p">Type your first message to start.</div>
        </div>
      )}
      {messages.map((msg, i) => <MessageBubble key={msg?.info?.id ?? i} msg={msg} />)}
      {thinking && (
        <div className="thinking-row">
          <div className="spin" />
          <span>thinking</span>
          <span className="dots"><span>.</span><span>.</span><span>.</span></span>
        </div>
      )}
      <div ref={bot} />
    </div>
  );
}

function NewProjectModal({ open, onClose, onDone, toast }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [selPath, setSelPath] = useState('');
  const [dirs, setDirs] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setPath('');
    setSelPath('');
    setDirs(null);
    
    async function fetchDirs() {
      try {
        const pi = await oc.getPath();
        const root = pi?.path ?? pi?.cwd ?? '';
        const nodes = await oc.listFiles(root);
        const list = (Array.isArray(nodes) ? nodes : [])
          .filter(n => n.type === 'directory' || n.isDirectory)
          .map(n => {
            const abs = n.path || n.name || '';
            const rel = root && abs.startsWith(root) ? abs.slice(root.length).replace(/^\/+/, '') : abs;
            return { label: rel.split('/').pop() || rel, rel, abs };
          })
          .filter(f => f.label && !f.label.startsWith('.'))
          .slice(0, 28);
        setDirs(list);
      } catch(e) {
        console.error(e.stack)
        setDirs([]);
      }
    }
    fetchDirs();
  }, [open]);

  function pick(rel, label) {
    setSelPath(rel);
    setPath(rel);
    setName(label);
  }

  function submit() {
    const n = name.trim(), p = (path || selPath).trim();
    if (!n) { toast('Enter a project name'); return; }
    setBusy(true);
    onDone({ name: n, path: p });
    setBusy(false);
  }

  if (!open) return null;

  return (
    <div className={`overlay open`} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="mbox">
        <div className="mhdr">
          <span className="m-title">New Project</span>
          <button className="m-x" onClick={onClose}>✕</button>
        </div>
        <div className="mbody">
          <div className="field">
            <label>Project name</label>
            <input type="text" placeholder="e.g. project1" value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()} autoFocus autoComplete="off" />
          </div>
          <div className="field">
            <label>Subfolder (working directory)</label>
            {dirs === null
              ? <div style={{ fontSize: 11, color: 'var(--text3)', padding: '4px 0' }}>Scanning workspace…</div>
              : <div className="folder-grid">
                  <div className={`folder-chip${selPath === '' && path === '' ? ' sel' : ''}`}
                    onClick={() => { setSelPath(''); setPath(''); }}>
                    <span>🏠</span><span>workspace root</span>
                  </div>
                  {dirs.map(d => (
                    <div key={d.abs} className={`folder-chip${selPath === d.rel ? ' sel' : ''}`}
                      onClick={() => pick(d.rel, d.label)} title={d.abs}>
                      <span>📁</span><span>{d.label}</span>
                    </div>
                  ))}
                </div>
            }
            <input style={{ marginTop: 7 }} type="text" placeholder="Or type a path…"
              value={path} onChange={e => { setPath(e.target.value); setSelPath(''); }}
              onKeyDown={e => e.key === 'Enter' && submit()} autoComplete="off" />
            <span className="field-note">opencode will be instructed to treat this as the project root for all file and shell operations.</span>
          </div>
        </div>
        <div className="mfoot">
          <button className="btn-cancel" onClick={onClose}>Cancel</button>
          <button className="btn-ok" disabled={busy} onClick={submit}>Add Project</button>
        </div>
      </div>
    </div>
  );
}

function ModelPickerModal({ open, onClose, models, onSelect }) {
  const [search, setSearch] = useState('');
  const [selIdx, setSelIdx] = useState(0);
  const listRef = useRef();

  useEffect(() => {
    if (open) { setSearch(''); setSelIdx(0); }
  }, [open]);

  const filtered = models.filter(m => 
    (m.provider + '/' + m.name).toLowerCase().includes(search.toLowerCase())
  );

  function handleKey(e) {
    if (!filtered.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); onSelect(filtered[selIdx]); return; }
    if (e.key === 'Escape') { onClose(); return; }
  }

  useEffect(() => {
    if (listRef.current && filtered[selIdx]) {
      listRef.current.children[selIdx]?.scrollIntoView({ block: 'nearest' });
    }
  }, [selIdx]);

  if (!open) return null;

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="mbox">
        <div className="mhdr">
          <span className="m-title">Select Model</span>
          <button className="m-x" onClick={onClose}>✕</button>
        </div>
        <div className="mbody">
          <input className="model-search" autoFocus placeholder="Search models..."
            value={search} onChange={e => { setSearch(e.target.value); setSelIdx(0); }}
            onKeyDown={handleKey} />
          <div className="model-list" ref={listRef}>
            {filtered.map((m, i) => (
              <div key={m.provider + '/' + m.name} className={`model-row${i === selIdx ? ' sel' : ''}`}
                onClick={() => onSelect(m)}>
                <span className="model-prov">{m.provider}</span>
                <span className="model-name">{m.name}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="mfoot">
          <button className="btn-cancel" onClick={onClose}>Cancel</button>
          <button className="btn-ok" onClick={() => onSelect(filtered[selIdx])}>Select</button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const { toast, toastEl } = useToast();
  const [status, setStatus] = useState({ ok: false, label: 'connecting…' });
  const [ocSessions, setOcSessions] = useState([]);
  const [projects, setProjects] = useState(loadProjects);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [curSessId, setCurSessId] = useState(() => loadOpenSession());
  const [curProjId, setCurProjId] = useState(null);
  const [messages, setMessages] = useState(null);
  const [thinking, setThinking] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newProjOpen, setNewProjOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState({ provider: 'opencode', name: 'big-pickle' });
  const [diffView, setDiffView] = useState({ active: false, files: [], selectedFile: null, loading: false, projectPath: null, selectedFiles: [] });
  const [commitMsgOpen, setCommitMsgOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitListOpen, setCommitListOpen] = useState(false);
  const [commitList, setCommitList] = useState([]);
  const evtRef = useRef(null);

  async function boot() {
    try {
      const h = await oc.health();
      setStatus({ ok: true, label: 'v' + (h?.version ?? '?') });
      await refreshSessions();
      if (curSessId) { await loadMessages(curSessId); }
    } catch {
      setStatus({ ok: false, label: 'opencode offline' });
      setTimeout(boot, 4000);
    }
  }

  useEffect(() => { boot(); }, []);

  useEffect(() => { saveOpenSession(curSessId); }, [curSessId]);

  async function refreshSessions() {
    try {
      const r = await oc.listSessions();
      setOcSessions(Array.isArray(r) ? r : []);
    } catch { setOcSessions([]); }
  }

  async function loadMessages(sessId) {
    if (!sessId) return;
    try {
      const r = await oc.listMessages(sessId);
      setMessages(Array.isArray(r) ? r : []);
    } catch { setMessages([]); }
  }

  function projSessions(proj) {
    return (proj.sessionIds ?? [])
      .map(id => ocSessions.find(s => s.id === id))
      .filter(Boolean);
  }

  function addProject({ name, path }) {
    const proj = { id: Date.now().toString(), name, path: path || '', sessionIds: [] };
    const next = [...projects, proj];
    setProjects(next);
    saveProjects(next);
    setExpandedIds(prev => new Set([...prev, proj.id]));
    setNewProjOpen(false);
    toast('Project added');
  }

  function removeProject(id) {
    if (!confirm('Remove this project? (Sessions in opencode are not deleted)')) return;
    const next = projects.filter(p => p.id !== id);
    setProjects(next);
    saveProjects(next);
    if (curProjId === id) { setCurProjId(null); setCurSessId(null); setMessages(null); }
  }

  function linkSession(projId, sessId) {
    const next = projects.map(p =>
      p.id === projId && !p.sessionIds.includes(sessId)
        ? { ...p, sessionIds: [...p.sessionIds, sessId] }
        : p
    );
    setProjects(next);
    saveProjects(next);
  }

  function unlinkSession(projId, sessId) {
    if (!confirm('Remove this session from the project?')) return;
    const next = projects.map(p =>
      p.id === projId ? { ...p, sessionIds: p.sessionIds.filter(id => id !== sessId) } : p
    );
    setProjects(next);
    saveProjects(next);
    if (curSessId === sessId) { setCurSessId(null); setMessages(null); }
  }

  async function selectSession(projId, sessId) {
    setCurProjId(projId);
    setCurSessId(sessId);
    setMessages(null);
    setThinking(false);
    setDrawerOpen(false);
    await refreshSessions();
    await loadMessages(sessId);
  }

  async function newSessionInProject(proj) {
    try {
      const title = proj.name + ' · ' + new Date().toLocaleDateString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const s = await oc.createSession(title);
      linkSession(proj.id, s.id);
      await refreshSessions();
      await selectSession(proj.id, s.id);

      if (proj.path) {
        setThinking(true);
        const primer =
          `For this entire session, your working directory is \`${proj.path}\`.\n` +
          `All file reads, writes, edits, and shell commands must use \`${proj.path}\` as the project root.\n` +
          `Always cd into \`${proj.path}\` before running shell commands.`;
        try {
          const r = await oc.sendMessage(s.id, [{ type: 'text', text: primer }], null, true);
          setThinking(false);
          await loadMessages(s.id);
        } catch (e) {
          setThinking(false);
        }
      }
      toast('Session created');
    } catch (e) { toast('Failed: ' + e.message); }
  }

  async function loadGitStatus(proj) {
    if (!proj) return;
    const pi = await oc.getPath();
    if (!pi) return;
    const workdir = pi?.cwd ?? pi?.path ?? '';
    const parentDir = workdir.replace('/workspace-ui', '');
    const path1 = workdir + '/' + proj.name;
    const path2 = parentDir + '/' + proj.name;
    let files = await git.getGitStatus(path1);
    let fullPath = path1;
    if (!Array.isArray(files) || files.length === 0) {
      files = await git.getGitStatus(path2);
      fullPath = path2;
    }
    if (!fullPath) return;
    setDiffView({ active: true, files: Array.isArray(files) ? files : [], selectedFile: null, loading: false, projectPath: fullPath });
  }

  async function refreshGitStatus() {
    const p = diffView.projectPath;
    if (!p) return;
    const files = await git.getGitStatus(p);
    setDiffView(prev => ({ ...prev, files: Array.isArray(files) ? files : [] }));
  }

  async function loadGitDiff(file) {
    const fullPath = diffView.projectPath;
    if (!fullPath) {
      setDiffView(prev => ({ ...prev, selectedFile: { path: file, loading: false, error: 'No project path' } }));
      return;
    }
    setDiffView(prev => ({ ...prev, selectedFile: { path: file, loading: true } }));
    try {
      const result = await git.getGitDiff(fullPath, file);
      setDiffView(prev => ({ ...prev, selectedFile: { path: file, loading: false, ...result } }));
    } catch (e) {
      setDiffView(prev => ({ ...prev, selectedFile: { path: file, loading: false, error: e.message } }));
    }
  }

  function goBackToFileList() {
    setDiffView(prev => ({ ...prev, selectedFile: null }));
  }

  function closeDiffView() {
    setDiffView({ active: false, files: [], selectedFile: null, loading: false, projectPath: null, selectedFiles: [] });
  }

  function toggleFileCheckbox(filePath) {
    setDiffView(prev => {
      const sel = prev.selectedFiles || [];
      const next = sel.includes(filePath) ? sel.filter(f => f !== filePath) : [...sel, filePath];
      return { ...prev, selectedFiles: next };
    });
  }

  function handleCommitClick() {
    if (!diffView.selectedFiles?.length) { toast('Select files to commit'); return; }
    setCommitMsgOpen(true);
  }

async function handleCommitConfirm() {
    if (!commitMsg?.trim()) { toast('Enter a commit message'); return; }
    if (!diffView.projectPath) { toast('No project path'); return; }
    setCommitMsgOpen(false);
    try {
      await git.commitFiles(diffView.projectPath, diffView.selectedFiles, commitMsg);
      toast('Committed: ' + diffView.selectedFiles.length + ' file(s)');
      setCommitMsg('');
      setDiffView(prev => ({ ...prev, selectedFiles: [] }));
      await refreshGitStatus();
    } catch (e) { toast('Commit failed: ' + e.message); }
  }

  async function handleRollbackClick() {
    if (!diffView.selectedFiles?.length) { toast('Select files to rollback'); return; }
    if (!diffView.projectPath) { toast('No project path'); return; }
    if (!confirm('Rollback ' + diffView.selectedFiles.length + ' file(s)? This discards all changes.')) return;
    try {
      await git.rollbackFiles(diffView.projectPath, diffView.selectedFiles);
      toast('Rolled back: ' + diffView.selectedFiles.length + ' file(s)');
      setDiffView(prev => ({ ...prev, selectedFiles: [] }));
      await refreshGitStatus();
    } catch (e) { toast('Rollback failed: ' + e.message); }
  }

  async function handleShowCommits() {
    if (!diffView.projectPath) { toast('No project path'); return; }
    try {
      const list = await git.getCommitList(diffView.projectPath, 20);
      setCommitList(list || []);
      setCommitListOpen(true);
    } catch (e) { toast('Failed to load commits: ' + e.message); }
  }

  async function handleSend({ text, slash }) {
    if (slash) { await handleSlash(slash); return; }
    if (!text || !curSessId || thinking) return;
    await doSend(text);
  }

  async function doSend(text, model) {
    setThinking(true);
    const optMsg = { info: { role: 'user', id: '_opt_' + Date.now() }, parts: [{ type: 'text', text }] };
    setMessages(prev => [...(prev ?? []), optMsg]);

    const modelOverride = model || selectedModel;
    try {
      await oc.sendMessage(
        curSessId,
        [{ type: 'text', text }], modelOverride ? { providerID: modelOverride.provider, modelID: modelOverride.name } : null,
        false,

        // onDelta — safe text append
        (messageID, partID, partType, delta) => {
          if (!delta) return;
          setMessages(prev => prev.map(m => {
            if (m.info?.id !== messageID) return m
            const parts = m.parts ?? []
            const existing = parts.find(p => p.id === partID)
            if (existing) {
              return {
                ...m,
                parts: parts.map(p =>
                  p.id === partID
                    ? { ...p, text: (p.text ?? '') + delta }  // ?? '' guards undefined
                    : p
                )
              }
            } else {
              return { ...m, parts: [...parts, { id: partID, type: partType, text: delta }] }
            }
          }))
        },

        // onPart — only overwrite text/reasoning parts once they're finalized (time.end exists)
        // always overwrite everything else (tool, step-start, step-finish, etc.)
        (messageID, part) => {
          setMessages(prev => prev.map(m => {
            if (m.info?.id !== messageID) return m
            const parts = m.parts ?? []
            const existing = parts.find(p => p.id === part.id)

            const isStreamingType = part.type === 'text' || part.type === 'reasoning'
            const isFinalized = part.time?.end != null

            if (existing) {
              // For streaming types: only replace once finalized, otherwise keep accumulated delta text
              if (isStreamingType && !isFinalized) return m
              return { ...m, parts: parts.map(p => p.id === part.id ? part : p) }
            } else {
              return { ...m, parts: [...parts, part] }
            }
          }))
        },

        // onMessage — create assistant message shell when first seen
        (info) => {
          if (info.role !== 'assistant') return
          setMessages(prev => {
            if (prev.find(m => m.info?.id === info.id)) return prev
            return [...prev, { info, parts: [] }]
          })
        }
      );
      setThinking(false);
      await loadMessages(curSessId);
    } catch (e) {
      setThinking(false);
      setMessages(prev => [...(prev ?? []),
        { info: { role: 'assistant', id: '_err_' + Date.now() },
          parts: [{ type: 'text', text: 'Error: ' + e.message }] }
      ]);
    }
  }

  async function handleSlash(cmd) {
    switch (cmd) {
      case '/new':
        if (!curProj) { toast('Select a project first'); return; }
        await newSessionInProject(curProj);
        break;
      case '/sessions':
        if (!curProj) { toast('Select a project first'); return; }
        const list = projSessions(curProj);
        const txt = list.length
          ? list.map(s => (s.id === curSessId ? '▸ ' : '  ') + (s.title ?? s.id.slice(0, 12))).join('\n')
          : '  (none)';
        appendSysMsg('Sessions in ' + curProj.name + ':\n' + txt);
        break;
      case '/models':
        if (!curSessId) { toast('Select a session first'); return; }
        try {
          const mods = await oc.listModels();
          setAvailableModels(mods);
          setModelPickerOpen(true);
        } catch (e) { toast('Models error: ' + e.message); }
        break;
      case '/fork':
        if (!curSessId || !curProjId) { toast('No active session'); return; }
        try {
          const s = await oc.forkSession(curSessId);
          linkSession(curProjId, s.id);
          await refreshSessions();
          await selectSession(curProjId, s.id);
          toast('Session forked');
        } catch (e) { toast('Fork failed: ' + e.message); }
        break;
      case '/clear':
        setMessages([]);
        toast('Cleared locally');
        break;
      case '/export':
        if (!messages?.length) { toast('Nothing to export'); return; }
        try {
          const blob = new Blob([JSON.stringify({ session: curSessId, messages }, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `oc-${curSessId?.slice(0, 8) ?? 'export'}.json`;
          a.click();
        } catch { toast('Export failed'); }
        break;
    }
  }

  function appendSysMsg(text) {
    setMessages(prev => [...(prev ?? []),
      { info: { role: 'system', id: '_sys_' + Date.now() }, parts: [{ type: 'text', text }] }
    ]);
  }

  async function abort() {
    if (!curSessId) return;
    try { await oc.abortSession(curSessId); } catch {}
    setThinking(false);
  }

  async function toggleExpand(id) {
    const wasExpanded = expandedIds.has(id);
    setExpandedIds(prev => {
      const next = new Set(prev);
      wasExpanded ? next.delete(id) : next.add(id);
      return next;
    });
    if (!wasExpanded) await refreshSessions();
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { setNewProjOpen(false); setDrawerOpen(false); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); setNewProjOpen(true); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const curProj = projects.find(p => p.id === curProjId);
  const curSess = ocSessions.find(s => s.id === curSessId);
  const sessName = curSess?.title ?? (curSessId ? curSessId.slice(0, 10) + '…' : null);

  return (
    <>
      <div className={`veil${drawerOpen ? ' open' : ''}`} onClick={() => setDrawerOpen(false)} />

      <nav className={`sidebar${drawerOpen ? ' open' : ''}`}>
        <div className="sb-hd">
          <div className="logo"><div className="logo-orb" />opencode</div>
          <button className="sb-x" onClick={() => setDrawerOpen(false)}>✕</button>
        </div>

        <button className="new-proj-btn" onClick={() => setNewProjOpen(true)}>
          <span style={{ fontSize: 15 }}>＋</span> New project…
        </button>

        <div className="sb-scroll">
          {projects.length === 0 && (
            <div style={{ padding: '12px 10px', fontSize: 11, color: 'var(--text3)', lineHeight: 1.7 }}>
              No projects yet.<br />Add one to get started.
            </div>
          )}

          {projects.map(proj => {
            const isExpanded = expandedIds.has(proj.id);
            const sessions = projSessions(proj);
            return (
              <div key={proj.id} className="proj-group">
                <div className={`proj-row${curProjId === proj.id ? ' active-proj' : ''}`}
                  onClick={() => { toggleExpand(proj.id); }}>
                  <span className={`proj-chevron${isExpanded ? ' open' : ''}`}>›</span>
                  <span className="proj-ico">📁</span>
                  <div className="proj-info">
                    <div className="proj-name">{proj.name}</div>
                    {proj.path && <div className="proj-path">{proj.path}</div>}
                  </div>
                  <button className="proj-del" onClick={e => { e.stopPropagation(); removeProject(proj.id); }}>✕</button>
                </div>

                {isExpanded && (
                  <div className="sess-list">
                    {sessions.map(s => (
                      <div key={s.id}
                        className={`sess-row${s.id === curSessId ? ' active' : ''}`}
                        onClick={() => selectSession(proj.id, s.id)}>
                        <span className="sess-name">{s.title ?? s.id.slice(0, 14) + '…'}</span>
                        <button className="sess-del" onClick={e => { e.stopPropagation(); unlinkSession(proj.id, s.id); }}>✕</button>
                      </div>
                    ))}
                    <div className="new-sess-row" onClick={() => { newSessionInProject(proj); setDrawerOpen(false); }}>
                      <span>＋</span> New session
                    </div>
                    <div className="new-sess-row" onClick={() => { loadGitStatus(proj); setDrawerOpen(false); }}>
                      <span>↔</span> View diffs
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="sb-ft">
          <span className={`s-dot${status.ok ? ' on' : ''}`} />
          <span>{status.label}</span>
        </div>
      </nav>

      <div className="main">
        <div className="topbar">
          <button className="burger" onClick={() => setDrawerOpen(o => !o)}>
            <span /><span /><span />
          </button>
          <div className="tb-info">
            <div className="tb-name">{curProj?.name ?? 'opencode'}</div>
            <div className="tb-sub">{sessName ?? (curProj ? 'no session selected' : 'no project selected')}</div>
          </div>
          {thinking
            ? <>
                <span className="tb-status thinking">● thinking</span>
                <button className="tb-abort" onClick={abort}>■ stop</button>
              </>
            : curSessId
              ? <span className="tb-status idle">ready</span>
              : null
          }
        </div>

        {diffView.active ? (
          <div className="diff-viewer">
            <div className="diff-header">
              <button className="back-btn" onClick={diffView.selectedFile ? goBackToFileList : closeDiffView}>
                {diffView.selectedFile ? '← Back' : '✕'}
              </button>
              <span className="diff-title">Git Diffs</span>
            </div>
            {!diffView.selectedFile ? (
              <div className="diff-file-list">
                <div className="diff-actions">
                  <button className="diff-action-btn" onClick={handleCommitClick}>Commit</button>
                  <button className="diff-action-btn" onClick={handleRollbackClick}>Rollback</button>
                  <button className="diff-action-btn" onClick={handleShowCommits} title="Commit History"><i className="fa-solid fa-code-branch"></i></button>
                </div>
                {diffView.loading ? (
                  <div className="diff-loading">Loading...</div>
                ) : diffView.files.length === 0 ? (
                  <div className="diff-empty">No changes or not a git repository</div>
                ) : (
                  diffView.files.map(f => (
                    <div key={f.path} className="diff-file-row" onClick={() => loadGitDiff(f.path)}>
                      <input
                        type="checkbox"
                        checked={diffView.selectedFiles?.includes(f.path) || false}
                        onChange={e => { e.stopPropagation(); toggleFileCheckbox(f.path); }}
                        onClick={e => e.stopPropagation()}
                      />
                      <span className={`diff-status ${f.isUnversioned ? 'unversioned' : f.isNew ? 'new' : f.isDeleted ? 'deleted' : 'modified'}`}>
                        {f.isUnversioned ? 'U' : f.isNew ? 'A' : f.isDeleted ? 'D' : 'M'}
                      </span>
                      <span className="diff-filename">{f.path}</span>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="diff-content">
                {diffView.selectedFile.loading ? (
                  <div className="diff-loading">Loading diff...</div>
                ) : diffView.selectedFile.error ? (
                  <div className="diff-error">{diffView.selectedFile.error}</div>
                ) : (
                  <GitDiff
                    filePath={diffView.selectedFile.path}
                    oldString={diffView.selectedFile.oldContent || ''}
                    newString={diffView.selectedFile.newContent || ''}
                  />
                )}
              </div>
            )}
          </div>
        ) : (
          <Thread
            messages={messages}
            thinking={thinking}
            contextPath={curProj?.path ?? null}
          />
        )}

        <MessageInput
          onSend={handleSend}
          disabled={!curSessId || thinking}
          selectedModel={selectedModel}
        />
      </div>

      <NewProjectModal
        open={newProjOpen}
        onClose={() => setNewProjOpen(false)}
        onDone={addProject}
        toast={toast}
      />

      <ModelPickerModal
        open={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        models={availableModels}
        onSelect={model => {
          setModelPickerOpen(false);
          setSelectedModel(model);
          toast('Model set to ' + model.provider + '/' + model.name);
        }}
      />

      {commitMsgOpen && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setCommitMsgOpen(false)}>
          <div className="mbox">
            <div className="mhdr">
              <span className="m-title">Commit Message</span>
              <button className="m-x" onClick={() => { setCommitMsgOpen(false); setCommitMsg(''); }}>✕</button>
            </div>
            <div className="mbody">
              <div className="field">
                <label>Commit message for {diffView.selectedFiles?.length} file(s)</label>
                <input
                  type="text"
                  autoFocus
                  placeholder="Describe your changes..."
                  value={commitMsg}
                  onChange={e => setCommitMsg(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && commitMsg.trim() && handleCommitConfirm()}
                />
              </div>
            </div>
            <div className="mfoot">
              <button className="btn-cancel" onClick={() => { setCommitMsgOpen(false); setCommitMsg(''); }}>Cancel</button>
              <button className="btn-ok" onClick={() => handleCommitConfirm()}>Commit</button>
            </div>
          </div>
        </div>
      )}

      {commitListOpen && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setCommitListOpen(false)}>
          <div className="mbox">
            <div className="mhdr">
              <span className="m-title">Commit History</span>
              <button className="m-x" onClick={() => setCommitListOpen(false)}>✕</button>
            </div>
            <div className="mbody" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              {commitList.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>No commits found</div>
              ) : (
                commitList.map((c, i) => (
                  <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid #333', fontFamily: 'monospace', fontSize: '13px' }}>
                    <span style={{ color: '#888', marginRight: '8px' }}>{c.hash?.slice(0, 7)}</span>
                    <span>{c.message}</span>
                  </div>
                ))
              )}
            </div>
            <div className="mfoot">
              <button className="btn-cancel" onClick={() => setCommitListOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {toastEl}
    </>
  );
}

export default App;
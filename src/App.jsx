import { useState, useEffect, useRef } from 'react';
import oc from './services/opencode';
import { git } from './services/git';
import { GitDiff, computeRawDiff } from './components/GitDiff';
import { FileEditor } from './components/FileEditor';
import { fetchJsonAbsolute, postJsonAbsolute } from './common/utils';
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
  try { return JSON.parse(localStorage.getItem(SESSION_STORE)) || null; } catch { return null; }
}
function saveOpenSession(projId, sessId) {
  try { localStorage.setItem(SESSION_STORE, JSON.stringify({ projectId: projId, sessionId: sessId })); } catch {}
}

function normalizeAbsPath(p) {
  if (!p || typeof p !== 'string') return p;
  const prefix = p.startsWith('/') ? '/' : '';
  const parts = p.split('/');
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length && stack[stack.length - 1] !== '..') stack.pop();
      else if (!prefix) stack.push('..');
      continue;
    }
    stack.push(part);
  }
  const joined = (prefix + stack.join('/')) || prefix || '.';
  return joined.replace(/\/+$/, '') || '/';
}

// The V2 server rejects relative and `~` directories with a blank 500, so
// every project path is resolved to an absolute path before it is stored/sent.
function resolveProjectPath(input, { root = '', home = '' } = {}) {
  const raw = (input ?? '').trim();
  const rootPath = root.replace(/\/+$/, '');
  // Fall back to deriving the home dir from a `…/workspace/…` root when the
  // helper server has not been restarted with the new `home` field yet.
  const homePath = (home || (rootPath.includes('/workspace/') ? rootPath.slice(0, rootPath.indexOf('/workspace/')) : '')).replace(/\/+$/, '');
  if (!raw) return root || '';
  let out = raw;
  if (raw === '~') out = homePath || raw;
  else if (raw.startsWith('~/')) out = homePath ? `${homePath}/${raw.slice(2)}` : raw;
  else if (raw.startsWith('/')) out = raw;
  else if (raw.startsWith('./')) out = rootPath ? `${rootPath}/${raw.slice(2)}` : raw;
  else out = rootPath ? `${rootPath}/${raw}` : raw;
  return out.startsWith('/') ? normalizeAbsPath(out) : out;
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
  const toolName = inv.tool ?? inv.toolName ?? 'tool';
  const state = inv.state;
  const status = typeof state === 'string' ? state : state?.status;
  const isRun = status === 'streaming' || status === 'running' || status === 'call';
  const failed = status === 'error';
  const input = state?.input ?? inv.args;
  const content = state?.content;
  const error = state?.error;

  let result = inv.result;
  if (error) {
    result = typeof error === 'string' ? error : (error.message ?? JSON.stringify(error));
  } else if (content?.length) {
    result = content.map(c => c.text ?? JSON.stringify(c)).join('\n');
  }

  const rawInput = input && typeof input === 'object' ? input : null;
  const filePath = rawInput?.filePath ?? rawInput?.path;
  const lowerName = toolName.toLowerCase();
  const isEdit = lowerName.includes('edit') || lowerName.includes('write') || lowerName.includes('patch');
  let editArgs = null;
  if (isEdit && filePath) {
    if (rawInput.oldString != null || rawInput.newString != null) {
      editArgs = { filePath, oldString: rawInput.oldString ?? '', newString: rawInput.newString ?? '' };
    } else if (rawInput.content != null) {
      editArgs = { filePath, oldString: '', newString: rawInput.content };
    }
  }

  const lines = [];
  if (input != null) {
    const shown = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    if (shown) lines.push('INPUT:\n' + shown);
  }
  if (result != null) {
    const r = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    lines.push('OUTPUT:\n' + r.slice(0, 2000) + (r.length > 2000 ? '\n…' : ''));
  }
  return (
    <div className="tool-wrap">
      <div className="tool-hdr" onClick={() => setOpen(o => !o)}>
        <span>{toolIcon(toolName)}</span>
        <span className="tool-label">{toolName}</span>
        <span className={`tool-st ${isRun ? 'run' : 'ok'}`}>{failed ? '✕ failed' : isRun ? '● running' : '✓ done'}</span>
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
    const err = msg?.info?.error;
    const isAborted = err?.name === 'MessageAbortedError'
      || err?.type?.toLowerCase?.().includes('abort');
    return (
      <div className="msg">
        <div className="msg-who who-ai">opencode {isAborted && <span className="msg-aborted">(aborted)</span>}</div>
        {isAborted ? null : (
          <>
            {err && <div className="reasoning">⚠ {err.message ?? err.type ?? 'Request failed'}</div>}
            {parts.map((p, i) => {
              if (p.type === 'text') {
                if (!p.text) return null;
                return <RichText key={i} text={p.text} className="bub-ai" />;
              }
              if (p.type === 'reasoning') {
                if (!p.text) return null;
                return <div key={i} className="reasoning">{p.text}</div>;
              }
              if (p.type === 'tool') return <ToolBlock key={i} inv={p} />;
              if (p.type === 'tool-invocation') return <ToolBlock key={i} inv={p.toolInvocation || {}} />;
              if (p.type === 'step-start' || p.type === 'step-finish') return null;
              return null;
            })}
          </>
        )}
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

function MessageInput({ value = '', onValueChange, onSend, disabled, selectedModel, modelLoading }) {
  const [focused, setFocused] = useState(false);
  const [hist, setHist] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [slashQ, setSlashQ] = useState('');
  const [slashSel, setSlashSel] = useState(0);
  const ta = useRef();

  function setText(v) { onValueChange?.(v); }

  function resize() {
    if (!ta.current) return;
    ta.current.style.height = 'auto';
    ta.current.style.height = Math.min(ta.current.scrollHeight, 150) + 'px';
  }

  useEffect(() => { resize(); }, [value]);

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
    const v = value.trim();
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
            value={value} onChange={onChange} onKeyDown={onKey}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            disabled={disabled} />
          <div className="inp-foot">
            <span className="inp-hint"><kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline · <kbd>↑</kbd> history</span>
            <span className={`inp-model${modelLoading ? ' inp-model-loading' : ''}`}>
              {modelLoading ? <span className="spin" /> : (selectedModel ? (selectedModel.label ?? selectedModel.name) : '')}
            </span>
            <button className="send-btn" disabled={disabled || !value.trim()} onClick={submit}>Send ↵</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Thread({ messages, thinking, contextPath, hasProject }) {
  const bot = useRef();
  const atBottom = useRef(true);

  useEffect(() => {
    if (atBottom.current) {
      bot.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, thinking]);

  const handleScroll = (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    atBottom.current = scrollHeight - scrollTop - clientHeight < 50;
  };

  if (messages === null) {
    return (
      <div className="thread" onScroll={handleScroll}>
        <div className="empty">
          <div className="empty-orb">◈</div>
          {hasProject ? (
            <>
              <div className="empty-h">Choose a session</div>
              <div className="empty-p">Select a session from the menu, or create a new one for this project.</div>
            </>
          ) : (
            <>
              <div className="empty-h">No session open</div>
              <div className="empty-p">Select a project and session from the menu, or create a new one.</div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="thread" onScroll={handleScroll}>
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

function NewProjectModal({ open, onClose, onDone, toast, workspace }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [selPath, setSelPath] = useState('');
  const [selAbs, setSelAbs] = useState('');
  const [root, setRoot] = useState('');
  const [home, setHome] = useState('');
  const [dirs, setDirs] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setPath('');
    setSelPath('');
    setSelAbs('');
    setRoot('');
    setHome('');
    setDirs(null);
    
    async function fetchDirs() {
      try {
        const pi = workspace?.root
          ? { path: workspace.root, cwd: workspace.root, home: workspace.home ?? '' }
          : await oc.getPath();
        const rootPath = pi?.path ?? pi?.cwd ?? '';
        setRoot(rootPath);
        setHome(pi?.home ?? '');
        const nodes = await oc.listFiles(rootPath);
        const list = (Array.isArray(nodes) ? nodes : [])
          .filter(n => n.type === 'directory' || n.isDirectory)
          .map(n => {
            const abs = n.path || n.name || '';
            const rel = rootPath && abs.startsWith(rootPath) ? abs.slice(rootPath.length).replace(/^\/+/, '') : abs;
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

  function pick(rel, label, abs) {
    setSelPath(rel);
    setSelAbs(abs);
    setPath(rel);
    setName(label);
  }

  function submit() {
    const n = name.trim();
    const input = (path || selPath).trim();
    const p = selAbs || resolveProjectPath(input, { root, home });
    if (!n) { toast('Enter a project name'); return; }
    if (!p || !p.startsWith('/')) { toast('Project path must be an absolute path'); return; }
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
                    onClick={() => { setSelPath(''); setSelAbs(root); setPath(''); }}>
                    <span>🏠</span><span>workspace root</span>
                  </div>
                  {dirs.map(d => (
                    <div key={d.abs} className={`folder-chip${selPath === d.rel ? ' sel' : ''}`}
                      onClick={() => pick(d.rel, d.label, d.abs)} title={d.abs}>
                      <span>📁</span><span>{d.label}</span>
                    </div>
                  ))}
                </div>
            }
            <input style={{ marginTop: 7 }} type="text" placeholder="Or type a path…"
              value={path} onChange={e => { setPath(e.target.value); setSelPath(''); setSelAbs(''); }}
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
    (m.provider + '/' + (m.label ?? m.name)).toLowerCase().includes(search.toLowerCase())
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
                <span className="model-name">{m.label ?? m.name}</span>
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
  const [curSessId, setCurSessId] = useState(null);
  const [curProjId, setCurProjId] = useState(null);
  const [messages, setMessages] = useState(null);
  const [thinking, setThinking] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newProjOpen, setNewProjOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const DEFAULT_SESSION_MODEL = { provider: 'opencode', name: 'beam-free' };
  const [availableModels, setAvailableModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_SESSION_MODEL);
  const [workspace, setWorkspace] = useState({ root: '', home: '' });
  const [diffView, setDiffView] = useState({ active: false, files: [], selectedFile: null, loading: false, projectPath: null, selectedFiles: [] });
  const [fileEditor, setFileEditor] = useState({ active: false, filePath: null, fileContent: null, raw: null });
  const [commitMsgOpen, setCommitMsgOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitListOpen, setCommitListOpen] = useState(false);
  const [commitList, setCommitList] = useState([]);
  const [bootDone, setBootDone] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [preview, setPreview] = useState({ open: false, port: '', url: '', frameUrl: '', nonce: 0, useProxy: false });
  const [previewConsoleOpen, setPreviewConsoleOpen] = useState(false);
  const [previewLogs, setPreviewLogs] = useState([]);
  const [previewConsoleStatus, setPreviewConsoleStatus] = useState('');
  const previewIframeRef = useRef(null);
  const previewConsoleCleanupRef = useRef(null);
  const [drafts, setDrafts] = useState({});
  const SCRIPTS_RECENT_STORE = 'oc_recent_scripts_v1';
  const [scriptsMenuOpen, setScriptsMenuOpen] = useState(false);
  const [projectScripts, setProjectScripts] = useState([]);
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [scriptsError, setScriptsError] = useState('');
  const [scriptFailureModal, setScriptFailureModal] = useState(null);
  const [scriptPending, setScriptPending] = useState({});
  const scriptsMenuRef = useRef(null);
  const scriptsSessionStartRef = useRef(Date.now());
  const scriptsReqIdRef = useRef(0);

  function loadRecentScriptsMap() {
    try { return JSON.parse(localStorage.getItem(SCRIPTS_RECENT_STORE) || '{}'); } catch { return {}; }
  }
  function saveRecentScriptsMap(map) {
    try { localStorage.setItem(SCRIPTS_RECENT_STORE, JSON.stringify(map)); } catch {}
  }
  function getRecentScriptNames(projPath) {
    if (!projPath) return [];
    const map = loadRecentScriptsMap();
    const arr = Array.isArray(map[projPath]) ? map[projPath] : [];
    return arr.filter(n => typeof n === 'string');
  }
  function markScriptUsed(projPath, name) {
    if (!projPath || !name) return;
    const map = loadRecentScriptsMap();
    const prev = Array.isArray(map[projPath]) ? map[projPath] : [];
    const next = [name, ...prev.filter(n => n !== name)].slice(0, 10);
    map[projPath] = next;
    saveRecentScriptsMap(map);
  }

  function getMessageHandlers() {
    return {
      onDelta: // onDelta — safe text append
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
      onPart:
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
      onMessage: // onMessage — create or update the assistant message shell
      (info) => {
        if (info.role !== 'assistant') return
        setMessages(prev => {
          const existing = prev.find(m => m.info?.id === info.id)
          if (existing) {
            return prev.map(m => m.info?.id === info.id
              ? { ...m, info: { ...m.info, ...info } }
              : m)
          }
          return [...prev, { info, parts: [] }]
        })
      }
    }
  }

  async function boot() {
    try {
      const h = await oc.health();
      if (!h.ok) throw new Error('opencode offline');
      setStatus({ ok: true, label: 'v' + (h?.version ?? '?') });

      try {
        const pi = await oc.getPath();
        setWorkspace({ root: pi?.path ?? pi?.cwd ?? '', home: pi?.home ?? '' });
      } catch { /* workspace info is best-effort */ }

      const openSession = loadOpenSession();
      if (openSession?.projectId) {
        setExpandedIds(prev => new Set([...prev, openSession.projectId]));
      }
      setCurProjId(openSession?.projectId ?? null);
      setCurSessId(openSession?.sessionId ?? null);

      await refreshSessions();
      if (openSession?.sessionId) {
        setSessionLoading(true);
        setModelLoading(true);
        try {
          let msgs = await loadMessages(openSession.sessionId);
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg?.info?.role === 'assistant' && lastMsg.info.finish == null
            && await oc.isSessionRunning(openSession.sessionId)) {
            const handlers = getMessageHandlers();
            setSessionLoading(false);
            setModelLoading(false);
            setThinking(true);
            try {
              await oc.subscribeToSession(openSession.sessionId, handlers);
            } finally {
              setThinking(false);
            }
            msgs = await loadMessages(openSession.sessionId);
          }
          await syncSelectedModelForSession(openSession.sessionId, msgs);
        } finally {
          setModelLoading(false);
          setSessionLoading(false);
        }
      }
    } catch {
      setStatus({ ok: false, label: 'opencode offline' });
      setTimeout(boot, 4000);
    }
    setBootDone(true);
  }

  useEffect(() => { boot(); }, []);

  useEffect(() => {
    if (!bootDone) return;
    saveOpenSession(curProjId, curSessId);
  }, [curProjId, curSessId, bootDone]);

  useEffect(() => {
    detachPreviewConsole();
    setPreviewConsoleOpen(false);
    setPreviewLogs([]);
    setPreviewConsoleStatus('');
    if (!curProjId) {
      setPreview({ open: false, port: '', url: '', frameUrl: '', nonce: 0, useProxy: false });
      return;
    }
    const port = getProjectPreviewPort(curProjId);
    if (port && /^\d+$/.test(port)) {
      const url = `${window.location.protocol}//${window.location.hostname}:${port}`;
      const frameUrl = `/__preview_proxy__/${port}/`;
      setPreview({ open: getProjectPreviewOpen(curProjId), port, url, frameUrl, nonce: 0, useProxy: getProjectPreviewProxy(curProjId) });
    } else {
      setPreview({ open: false, port: '', url: '', frameUrl: '', nonce: 0, useProxy: false });
    }
  }, [curProjId, projects]);

  function modelFromSessionData(session, msgs = []) {
    const raw = session?.model ?? session?.config?.model;
    const candidates = [raw];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.info?.role === 'assistant' && m.info.model) candidates.push(m.info.model);
    }
    for (const c of candidates) {
      if (!c) continue;
      const provider = c.providerID ?? c.provider;
      const name = c.modelID ?? c.id ?? c.name;
      if (provider && name) {
        const label = c.modelName ?? c.label ?? name;
        const ref = { provider, name, label };
        if (c.variant) ref.variant = c.variant;
        return ref;
      }
    }
    return null;
  }

  async function syncSelectedModelForSession(sessId, msgs = null) {
    if (!sessId) return;
    try {
      const [session, loadedMsgs] = await Promise.all([
        oc.getSession(sessId).catch(() => null),
        msgs ? Promise.resolve(msgs) : oc.listMessages(sessId).catch(() => []),
      ]);
      const model = modelFromSessionData(session, Array.isArray(loadedMsgs) ? loadedMsgs : []);
      if (model) setSelectedModel(model);
    } catch {}
  }

  async function refreshSessions() {
    try {
      const r = await oc.listSessions();
      setOcSessions(Array.isArray(r) ? r : []);
    } catch { setOcSessions([]); }
  }

  async function loadMessages(sessId) {
    if (!sessId) return [];
    try {
      const r = await oc.listMessages(sessId);
      const msgs = Array.isArray(r) ? r : [];
      setMessages(msgs);
      return msgs;
    } catch { setMessages([]); return []; }
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

  function closePreviewPane(persistForProjId = curProjId) {
    detachPreviewConsole();
    setPreviewConsoleOpen(false);
    setPreviewLogs([]);
    setPreviewConsoleStatus('');
    setPreview(p => ({ ...p, open: false }));
    if (persistForProjId) saveProjectPreviewState(persistForProjId, { open: false });
  }

  async function selectProjectOnly(proj) {
    if (!proj) return;
    const sameProjectWithSession = curProjId === proj.id && !!curSessId;
    closePreviewPane(curProjId);
    setCurProjId(proj.id);
    setDrawerOpen(false);
    setExpandedIds(prev => new Set([...prev, proj.id]));
    if (sameProjectWithSession) {
      setDiffView({ active: false, files: [], selectedFile: null, loading: false, projectPath: null, selectedFiles: [] });
    } else {
      setCurSessId(null);
      setMessages(null);
      setThinking(false);
      setSessionLoading(false);
      setModelLoading(false);
      setDiffView({ active: false, files: [], selectedFile: null, loading: false, projectPath: null, selectedFiles: [] });
    }
    await refreshSessions();
  }

  async function selectSession(projId, sessId) {
    closePreviewPane(curProjId);
    setCurProjId(projId);
    setCurSessId(sessId);
    setMessages(null);
    setThinking(false);
    setDrawerOpen(false);
    setDiffView(prev => ({ ...prev, active: false }));
    setSessionLoading(true);
    setModelLoading(true);
    try {
      await refreshSessions();
      const msgs = await loadMessages(sessId);
      await syncSelectedModelForSession(sessId, msgs);
    } finally {
      setModelLoading(false);
      setSessionLoading(false);
    }
  }

  async function newSessionInProject(proj) {
    try {
      const title = proj.name + ' · ' + new Date().toLocaleDateString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const directory = resolveProjectPath(proj.path, workspace);
      const s = await oc.createSession(title, { directory: directory || undefined, model: DEFAULT_SESSION_MODEL });
      if (!s?.id) throw new Error('Session creation returned no id');
      const nextProjects = projects.map(p => {
        if (p.id !== proj.id) return p;
        const updated = { ...p, sessionIds: p.sessionIds.includes(s.id) ? p.sessionIds : [...p.sessionIds, s.id] };
        if (directory && directory !== proj.path) updated.path = directory;
        return updated;
      });
      setProjects(nextProjects);
      saveProjects(nextProjects);
      await refreshSessions();
      setSelectedModel(DEFAULT_SESSION_MODEL);
      await selectSession(proj.id, s.id);

      if (directory) {
        setThinking(true);
        const primer =
          `For this entire session, your working directory is \`${directory}\`.\n` +
          `All file reads, writes, edits, and shell commands must use \`${directory}\` as the project root.\n` +
          `Always cd into \`${directory}\` before running shell commands.`;
        try {
          await oc.sendMessage(s.id, primer, { resume: false, model: DEFAULT_SESSION_MODEL });
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
    const pi = workspace?.root ? { path: workspace.root, cwd: workspace.root } : await oc.getPath();
    if (!pi) return;
    const ws = { root: pi?.cwd ?? pi?.path ?? '', home: workspace?.home ?? pi?.home ?? '' };
    const candidates = [];
    if (proj.path) candidates.push(resolveProjectPath(proj.path, ws));
    const workdir = pi?.cwd ?? pi?.path ?? '';
    const parentDir = workdir.replace('/workspace-ui', '');
    candidates.push(normalizeAbsPath(workdir + '/' + proj.name));
    if (parentDir && parentDir !== workdir) candidates.push(normalizeAbsPath(parentDir + '/' + proj.name));

    let files = null;
    let fullPath = '';
    let lastErr = null;
    for (const p of [...new Set(candidates.filter(Boolean))]) {
      try {
        const res = await git.getGitStatus(p);
        files = Array.isArray(res) ? res : [];
        fullPath = p;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!fullPath) {
      toast('Could not load git status: ' + (lastErr?.message || 'unknown error'));
      return;
    }
    const keepSession = curProjId === proj.id && !!curSessId;
    closePreviewPane(curProjId);
    setCurProjId(proj.id);
    setExpandedIds(prev => new Set([...prev, proj.id]));
    if (!keepSession) {
      setCurSessId(null);
      setMessages(null);
      setThinking(false);
      setSessionLoading(false);
      setModelLoading(false);
    }
    setDiffView({ active: true, files, selectedFile: null, loading: false, projectPath: fullPath, selectedFiles: [] });
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

  async function openInEditor(filePath) {
    try {
      const res = await fetch(`/file?path=${encodeURIComponent(diffView.projectPath + '/' + filePath)}`);
      const { content } = await res.json();

      const diff = await git.getGitDiff(diffView.projectPath, filePath);

      const raw = diff?.oldContent && diff?.newContent
        ? computeRawDiff(diff.oldContent, diff.newContent)
        : null;

      setFileEditor({
        active: true,
        filePath: diffView.projectPath + '/' + filePath,
        fileContent: content,
        raw
      });
    } catch (e) {
      console.log(e.message)
      toast('Could not open file: ' + e.message);
    }
  }

  async function saveFile(filePath, content) {
    await fetch('/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content })
    });
    toast('Saved');
    setFileEditor({ active: false, filePath: null, fileContent: null, raw: null });
    if (diffView.active) {
      await refreshGitStatus();
      if (diffView.selectedFile?.path) {
        await loadGitDiff(diffView.selectedFile.path);
      }
    }
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
      const handlers = getMessageHandlers();
      await oc.sendMessage(curSessId, text, { model: modelOverride, handlers });
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

  function getProjectPreviewPort(projId) {
    const proj = projects.find(p => p.id === projId);
    return proj?.previewPort ? String(proj.previewPort) : '';
  }

  function getProjectPreviewOpen(projId) {
    const proj = projects.find(p => p.id === projId);
    return !!proj?.previewOpen;
  }

  function getProjectPreviewProxy(projId) {
    const proj = projects.find(p => p.id === projId);
    return !!proj?.previewProxy;
  }

  function saveProjectPreviewState(projId, { port, open, useProxy } = {}) {
    if (!projId) return;
    const next = projects.map(p => {
      if (p.id !== projId) return p;
      const updated = { ...p };
      if (port !== undefined) updated.previewPort = port;
      if (open !== undefined) updated.previewOpen = open;
      if (useProxy !== undefined) updated.previewProxy = useProxy;
      return updated;
    });
    setProjects(next);
    saveProjects(next);
  }

  function clearPreviewConsole() {
    setPreviewLogs([]);
  }

  function appendPreviewLog(level, args) {
    const formatArg = (a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message || String(a);
      try { return JSON.stringify(a); } catch { return String(a); }
    };
    const text = (Array.isArray(args) ? args : [args]).map(formatArg).join(' ');
    setPreviewLogs(prev => {
      const next = [...prev, { id: Date.now() + Math.random(), level, text, ts: new Date().toLocaleTimeString() }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }

  function detachPreviewConsole() {
    if (previewConsoleCleanupRef.current) {
      try { previewConsoleCleanupRef.current(); } catch {}
      previewConsoleCleanupRef.current = null;
    }
  }

  function attachPreviewConsole() {
    detachPreviewConsole();
    const iframe = previewIframeRef.current;
    if (!iframe) return;
    try {
      const win = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!win || !doc) throw new Error('unavailable');
      // Access check for cross-origin
      void win.location.href;
      const originals = {};
      ['log', 'info', 'warn', 'error', 'debug'].forEach(level => {
        if (typeof win.console?.[level] !== 'function') return;
        originals[level] = win.console[level].bind(win.console);
        win.console[level] = (...args) => {
          try { appendPreviewLog(level, args); } catch {}
          try { originals[level](...args); } catch {}
        };
      });
      const onError = (e) => appendPreviewLog('error', [e?.message || 'Error', e?.filename ? `(${e.filename}:${e.lineno}:${e.colno})` : '']);
      const onRejection = (e) => appendPreviewLog('error', ['Unhandled rejection:', e?.reason]);
      win.addEventListener('error', onError);
      win.addEventListener('unhandledrejection', onRejection);
      setPreviewConsoleStatus('');
      previewConsoleCleanupRef.current = () => {
        try {
          Object.keys(originals).forEach(level => { if (win.console) win.console[level] = originals[level]; });
          win.removeEventListener('error', onError);
          win.removeEventListener('unhandledrejection', onRejection);
        } catch {}
      };
    } catch {
      if (preview.useProxy === false) {
        setPreviewConsoleStatus('Enable Proxy to capture console.log() output (may affect app behavior).');
      } else {
        setPreviewConsoleStatus('Direct console capture unavailable. If the app posts { source: "workspace-preview-console", level, args } via window.parent.postMessage, logs will appear here.');
      }
    }
  }

  function handlePreviewFrameLoad() {
    attachPreviewConsole();
  }

  useEffect(() => {
    if (!preview.url) return;
    function onMessage(e) {
      const iframeWin = previewIframeRef.current?.contentWindow;
      if (iframeWin && e.source !== iframeWin) return;
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      const isConsoleMsg = d.source === 'workspace-preview-console' || d.__preview_console__ || d.type === 'preview-console';
      if (!isConsoleMsg) return;
      const level = ['log', 'info', 'warn', 'error', 'debug'].includes(d.level) ? d.level : 'log';
      const payload = d.args ?? d.message ?? d.text ?? d.data ?? '';
      appendPreviewLog(level, Array.isArray(payload) ? payload : [payload]);
      setPreviewConsoleStatus(s => s.startsWith('Direct console capture unavailable') ? '' : s);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [preview.url, preview.nonce]);

  function openPreviewForPort(port, { saveForProject = false, open = true, useProxy } = {}) {
    if (!/^\d+$/.test(port)) {
      toast('Invalid port');
      return;
    }
    const url = `${window.location.protocol}//${window.location.hostname}:${port}`;
    const frameUrl = `/__preview_proxy__/${port}/`;
    const resolvedUseProxy = typeof useProxy === 'boolean'
      ? useProxy
      : (curProjId ? getProjectPreviewProxy(curProjId) : preview.useProxy ?? false);
    detachPreviewConsole();
    setPreviewLogs([]);
    setPreviewConsoleStatus('');
    setPreview({ open, port, url, frameUrl, nonce: open ? Date.now() : 0, useProxy: resolvedUseProxy });
    if (saveForProject && curProjId) saveProjectPreviewState(curProjId, { port, open, useProxy: resolvedUseProxy });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  function togglePreviewProxy() {
    detachPreviewConsole();
    setPreviewLogs([]);
    setPreviewConsoleStatus('');
    setPreview(p => {
      const next = !p.useProxy;
      if (curProjId) saveProjectPreviewState(curProjId, { useProxy: next });
      return { ...p, useProxy: next, nonce: Date.now() };
    });
  }

  useEffect(() => () => detachPreviewConsole(), []);

  function openPreview() {
    if (!curProjId || thinking) return;
    let port = getProjectPreviewPort(curProjId) || preview.port;
    if (!port) {
      const input = window.prompt('Enter port for web preview', '3000');
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (!input) return;
      port = input.trim();
      openPreviewForPort(port, { saveForProject: true, open: true });
      return;
    }
    openPreviewForPort(port, { saveForProject: true, open: true });
  }

  function normalizeProjectScripts(res) {
    const sessionStart = scriptsSessionStartRef.current;
    return (Array.isArray(res?.scripts) ? res.scripts : []).map(s => {
      const lr = s?.lastRun;
      if (!lr || !lr.finishedAt || lr.finishedAt < sessionStart) {
        const { lastRun, ...rest } = s || {};
        return rest;
      }
      return s;
    });
  }

  async function fetchProjectScripts(projPath = curProj?.path) {
    if (!projPath) return [];
    const res = await fetchJsonAbsolute(`/scripts?path=${encodeURIComponent(projPath)}`);
    if (res?.error) throw new Error(res.error);
    return normalizeProjectScripts(res);
  }

  async function loadProjectScripts(projPath = curProj?.path, { silent = false } = {}) {
    if (!projPath) return [];
    const reqId = ++scriptsReqIdRef.current;
    if (!silent) {
      setScriptsLoading(true);
      setScriptsError('');
    }
    try {
      const scripts = await fetchProjectScripts(projPath);
      if (reqId !== scriptsReqIdRef.current) return [];
      setProjectScripts(scripts);
      return scripts;
    } catch (e) {
      if (reqId !== scriptsReqIdRef.current) return [];
      if (!silent) {
        setScriptsError(e.message || 'Failed to load scripts');
        setProjectScripts([]);
      }
      return [];
    } finally {
      if (reqId === scriptsReqIdRef.current && !silent) setScriptsLoading(false);
    }
  }

  async function toggleScriptsMenu() {
    if (!curProj?.path) return;
    const next = !scriptsMenuOpen;
    setScriptsMenuOpen(next);
    if (next) await loadProjectScripts(curProj.path);
  }

  function setScriptPendingState(name, state) {
    setScriptPending(prev => {
      const next = { ...prev };
      if (!state) delete next[name];
      else next[name] = state;
      return next;
    });
  }

  async function waitForScriptState(projPath, name, predicate, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const scripts = await loadProjectScripts(projPath, { silent: true });
      const s = scripts.find(x => x.name === name);
      if (s && predicate(s)) return s;
      await new Promise(r => setTimeout(r, 400));
    }
    const scripts = await loadProjectScripts(projPath);
    return scripts.find(x => x.name === name) || null;
  }

  async function startProjectScript(name) {
    const projPath = curProj?.path;
    if (!projPath) return;
    if (scriptPending[name]) return;
    setScriptPendingState(name, 'starting');
    try {
      const res = await postJsonAbsolute('/scripts/start', { path: projPath, name });
      if (res?.error) throw new Error(res.error);
      markScriptUsed(projPath, name);
      await waitForScriptState(
        projPath,
        name,
        s => !!s.running || (s.lastRun?.status === 'failed' && (s.lastRun.finishedAt || 0) >= scriptsSessionStartRef.current),
      );
    } catch (e) {
      toast(e.message || 'Failed to start script');
    } finally {
      setScriptPendingState(name, null);
      await loadProjectScripts(projPath);
    }
  }

  async function stopProjectScript(name) {
    const projPath = curProj?.path;
    if (!projPath) return;
    if (scriptPending[name]) return;
    setScriptPendingState(name, 'stopping');
    try {
      const res = await postJsonAbsolute('/scripts/stop', { path: projPath, name });
      if (res?.error) throw new Error(res.error);
      await waitForScriptState(projPath, name, s => !s.running);
    } catch (e) {
      toast(e.message || 'Failed to stop script');
    } finally {
      setScriptPendingState(name, null);
      await loadProjectScripts(projPath);
    }
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
      if (e.key === 'Escape') { setNewProjOpen(false); setDrawerOpen(false); setScriptsMenuOpen(false); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); setNewProjOpen(true); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!scriptsMenuOpen) return;
    function onDocClick(e) {
      if (scriptsMenuRef.current && !scriptsMenuRef.current.contains(e.target)) {
        setScriptsMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [scriptsMenuOpen]);

  useEffect(() => {
    setScriptsMenuOpen(false);
    setProjectScripts([]);
    setScriptsError('');
    setScriptFailureModal(null);
    setScriptPending({});
  }, [curProjId]);

  const curProj = projects.find(p => p.id === curProjId);
  const curSess = ocSessions.find(s => s.id === curSessId);
  const sessName = curSess?.title ?? (curSessId ? curSessId.slice(0, 10) + '…' : null);

  useEffect(() => {
    if (!curProj?.path) return;
    setScriptPending({});
    loadProjectScripts(curProj.path);
  }, [curProj?.path]);

  useEffect(() => {
    if (!projects || projects.length === 0) return;
    const paths = [...new Set(projects.map(p => p?.path).filter(Boolean))];
    if (paths.length === 0) return;
    postJsonAbsolute('/scripts/cleanup', { paths }).catch(() => {});
    // Run once on mount/reload for projects in this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!scriptsMenuOpen || !curProj?.path) return;
    const id = setInterval(() => {
      loadProjectScripts(curProj.path);
    }, 2000);
    return () => clearInterval(id);
  }, [scriptsMenuOpen, curProj?.path]);

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
                  onClick={() => { selectProjectOnly(proj); }}>
                  <span className={`proj-chevron${isExpanded ? ' open' : ''}`}
                    onClick={e => { e.stopPropagation(); toggleExpand(proj.id); }}>›</span>
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
        {preview.url && (
          <div className="preview-viewer" style={{ display: preview.open ? 'flex' : 'none' }}>
            <div className="preview-header">
              <button className="back-btn" onClick={() => {
                detachPreviewConsole();
                setPreviewConsoleOpen(false);
                setPreview(p => ({ ...p, open: false }));
                saveProjectPreviewState(curProjId, { open: false });
              }}>✕</button>
              <span className="preview-url">{preview.url}</span>
              <button className="diff-action-btn" onClick={() => {
                const input = window.prompt('Enter port for web preview', getProjectPreviewPort(curProjId) || preview.port || '3000');
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                if (!input) return;
                openPreviewForPort(input.trim(), { saveForProject: true, open: true });
              }}>Port</button>
              <button
                className={`diff-action-btn${previewConsoleOpen ? ' active' : ''}`}
                onClick={() => setPreviewConsoleOpen(o => !o)}
                title="Console output"
                aria-label="Console output"
              >{'</>'}</button>
              <button className="diff-action-btn" onClick={() => window.open(preview.url, '_blank', 'noopener,noreferrer')} title="Open in new tab">↗</button>
            </div>
            <div className="preview-body">
              <iframe key={preview.nonce} ref={previewIframeRef} className="preview-frame" src={(preview.useProxy ? (preview.frameUrl || preview.url) : preview.url)} title="App preview" onLoad={handlePreviewFrameLoad} />
              {previewConsoleOpen && (
                <div className="preview-console">
                  <div className="preview-console-hd">
                    <span>Console</span>
                    <div className="preview-console-actions">
                      <button
                        className={`diff-action-btn preview-proxy-toggle${preview.useProxy ? ' active' : ''}`}
                        onClick={togglePreviewProxy}
                        title={preview.useProxy ? 'Proxy on: same-origin preview for console capture (click to load directly)' : 'Proxy off: direct port/origin preview (click to enable proxy for console capture)'}
                      >Proxy</button>
                      <button className="diff-action-btn" onClick={clearPreviewConsole} title="Clear console">Clear</button>
                    </div>
                  </div>
                  <div className="preview-console-body">
                    {previewConsoleStatus && <div className="preview-console-status">{previewConsoleStatus}</div>}
                    {previewLogs.length === 0 && !previewConsoleStatus && <div className="preview-console-empty">No console output yet.</div>}
                    {previewLogs.map(log => (
                      <div key={log.id} className={`preview-console-line level-${log.level}`}>
                        <span className="preview-console-ts">{log.ts}</span>
                        <span className="preview-console-msg">{log.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {!preview.open && (
          <>
            <div className="topbar">
              <button className="burger" onClick={() => setDrawerOpen(o => !o)}>
                <span /><span /><span />
              </button>
              <div className="tb-info">
                <div className="tb-name">{curProj?.name ?? 'opencode'}</div>
                <div className="tb-sub">{sessName ?? (curProj ? 'no session selected' : 'no project selected')}</div>
              </div>
              {curProj?.path && !thinking && (
                <div className="tb-scripts" ref={scriptsMenuRef}>
                  <button
                    className="tb-play"
                    onClick={toggleScriptsMenu}
                    title="Run package.json scripts"
                    aria-label="Run package.json scripts"
                  >▶</button>
                  {scriptsMenuOpen && (
                    <div className="scripts-menu">
                      <div className="scripts-menu-hd">Scripts</div>
                      {scriptsLoading && projectScripts.length === 0 ? (
                        <div className="scripts-menu-empty">Loading…</div>
                      ) : scriptsError ? (
                        <div className="scripts-menu-empty scripts-menu-error">{scriptsError}</div>
                      ) : projectScripts.length === 0 ? (
                        <div className="scripts-menu-empty">No scripts found</div>
                      ) : (() => {
                        const byName = new Map(projectScripts.map(s => [s.name, s]));
                        const recentNames = getRecentScriptNames(curProj?.path)
                          .filter(n => byName.has(n))
                          .slice(0, 3);
                        const recent = recentNames.map(n => byName.get(n)).filter(Boolean);
                        const recentSet = new Set(recentNames);
                        const alphabetical = [...projectScripts]
                          .filter(s => !recentSet.has(s.name))
                          .sort((a, b) => a.name.localeCompare(b.name));
                        const renderRow = (s, keyPrefix = '') => {
                          const pending = scriptPending[s.name];
                          const showStop = s.running || pending === 'stopping';
                          return (
                            <div key={`${keyPrefix}${s.name}`} className="scripts-menu-row">
                              <span className="scripts-menu-name" title={s.command}>{s.name}</span>
                              <div className="scripts-menu-actions">
                                {s.lastRun?.status === 'success' && !s.running && !pending && <span className="script-last-status success" title="Last run succeeded">✓</span>}
                                {s.lastRun?.status === 'failed' && !s.running && !pending && (
                                  <button
                                    className="script-last-status failed"
                                    onClick={() => setScriptFailureModal({ name: s.name, ...s.lastRun, output: s.lastRun.output || s.lastRun.error || '' })}
                                    title="Last run failed (click for details)"
                                    aria-label={`${s.name} last run failed`}
                                  >✕</button>
                                )}
                                <button
                                  className={`scripts-run-btn ${showStop ? 'stop' : 'start'}`}
                                  disabled={!!pending}
                                  onClick={() => showStop ? stopProjectScript(s.name) : startProjectScript(s.name)}
                                  title={pending === 'starting' ? `Starting ${s.name}` : pending === 'stopping' ? `Stopping ${s.name}` : showStop ? `Stop ${s.name}` : `Run ${s.name}`}
                                  aria-label={pending ? `${pending} ${s.name}` : showStop ? `Stop ${s.name}` : `Run ${s.name}`}
                                >{pending ? <span className="spin scripts-btn-spin" /> : showStop ? '■' : '▶'}</button>
                              </div>
                            </div>
                          );
                        };
                        return (
                          <>
                            {recent.length > 0 && (
                              <>
                                <div className="scripts-menu-subhd">Recent</div>
                                {recent.map(s => renderRow(s, 'recent-'))}
                                <div className="scripts-menu-subhd">A–Z</div>
                              </>
                            )}
                            {alphabetical.map(s => renderRow(s, 'az-'))}
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
              {thinking ? (
                <>
                  <span className="tb-status thinking">● thinking</span>
                  <button className="tb-abort" onClick={abort}>■ stop</button>
                </>
              ) : curProj ? (
                <button className="tb-preview" onClick={openPreview} title={preview.port ? `Open preview (:${preview.port})` : 'Open web preview'}>👁</button>
              ) : null}
            </div>

            {sessionLoading ? (
              <div className="session-loading" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="spin" style={{ width: 28, height: 28 }} />
              </div>
            ) : fileEditor.active ? (
              <FileEditor
                filePath={fileEditor.filePath}
                fileContent={fileEditor.fileContent}
                raw={fileEditor.raw}
                onSave={saveFile}
                onClose={() => setFileEditor({ active: false, filePath: null, fileContent: null, raw: null })}
              />
            ) : diffView.active ? (
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
                        isImage={diffView.selectedFile.isImage || false}
                        openEditor={openInEditor}
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
                hasProject={!!curProj}
              />
            )}

            <MessageInput
              value={curSessId ? (drafts[curSessId] ?? '') : ''}
              onValueChange={(v) => curSessId && setDrafts(p => ({ ...p, [curSessId]: v }))}
              onSend={handleSend}
              disabled={!curSessId || thinking || sessionLoading}
              selectedModel={sessionLoading ? null : selectedModel}
              modelLoading={false}
            />
          </>
        )}
      </div>

      <NewProjectModal
        open={newProjOpen}
        onClose={() => setNewProjOpen(false)}
        onDone={addProject}
        toast={toast}
        workspace={workspace}
      />

      <ModelPickerModal
        open={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        models={availableModels}
        onSelect={model => {
          setModelPickerOpen(false);
          setSelectedModel(model);
          toast('Model set to ' + model.provider + '/' + (model.label ?? model.name));
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

      {scriptFailureModal && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setScriptFailureModal(null)}>
          <div className="mbox">
            <div className="mhdr">
              <span className="m-title">Script failed: {scriptFailureModal.name}</span>
              <button className="m-x" onClick={() => setScriptFailureModal(null)}>✕</button>
            </div>
            <div className="mbody">
              <div className="script-failure-meta">
                {scriptFailureModal.code != null ? `Exit code: ${scriptFailureModal.code}` : ''}
                {scriptFailureModal.signal ? ` (signal ${scriptFailureModal.signal})` : ''}
              </div>
              <pre className="script-failure-output">{scriptFailureModal.output || scriptFailureModal.error || 'No error output captured.'}</pre>
            </div>
            <div className="mfoot">
              <button className="btn-ok" onClick={() => setScriptFailureModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {toastEl}
    </>
  );
}

export default App;
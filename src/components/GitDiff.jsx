
// ── Core diff renderer ────────────────────────────────────────────────────────

function renderDiff(oldString, newString) {
  // Handle both real newlines and literal \n escape sequences
  const unescape = s => s.replace(/\\n/g, "\n");
  const oldLines = unescape(oldString).split("\n");
  const newLines = unescape(newString).split("\n");

  // Simple LCS-based line diff
  const lcs = computeLCS(oldLines, newLines);
  const hunks = buildHunks(oldLines, newLines, lcs);
  return hunks;
}

function computeLCS(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);

  // Backtrack
  const seq = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { seq.unshift([i - 1, j - 1]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return seq; // pairs of [aIdx, bIdx]
}

function buildHunks(oldLines, newLines, lcs) {
  // Build diff lines: type = 'context' | 'removed' | 'added'
  const result = [];
  let ai = 0, bi = 0, li = 0;
  const CONTEXT = 3;

  // Collect raw diff
  const raw = [];
  while (ai < oldLines.length || bi < newLines.length) {
    const match = lcs[li];
    if (match && match[0] === ai && match[1] === bi) {
      raw.push({ type: "context", text: oldLines[ai], oldLine: ai + 1, newLine: bi + 1 });
      ai++; bi++; li++;
    } else if (match && match[0] > ai || (!match && ai < oldLines.length)) {
      raw.push({ type: "removed", text: oldLines[ai], oldLine: ai + 1, newLine: null });
      ai++;
    } else {
      raw.push({ type: "added", text: newLines[bi], oldLine: null, newLine: bi + 1 });
      bi++;
    }
  }

  // Slice into hunks with context
  const changeIndices = raw.map((r, i) => r.type !== "context" ? i : -1).filter(i => i >= 0);
  if (changeIndices.length === 0) return [];

  const hunks = [];
  let hunkRanges = [];
  let current = null;
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(raw.length - 1, idx + CONTEXT);
    if (!current) { current = { start, end }; }
    else if (start <= current.end + 1) { current.end = Math.max(current.end, end); }
    else { hunkRanges.push(current); current = { start, end }; }
  }
  if (current) hunkRanges.push(current);

  for (const { start, end } of hunkRanges) {
    hunks.push(raw.slice(start, end + 1));
  }
  return hunks;
}

// ── Syntax highlight (simple token coloring) ─────────────────────────────────

const KEYWORDS = /\b(const|let|var|function|return|import|export|default|from|if|else|for|while|class|extends|new|typeof|instanceof|null|undefined|true|false|async|await|of|in|type|interface|=>)\b/g;
const STRINGS = /(["'`])(?:(?!\1)[^\\]|\\.)*?\1/g;
const JSX_TAG = /(<\/?[A-Za-z][A-Za-z0-9.]*)/g;
const JSX_ATTR = /\s([a-zA-Z-]+)(?==)/g;
const COMMENTS = /(\/\/.*|\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\})/g;
const BRACES = /([{}[\]()])/g;

function tokenize(line) {
  const KEYWORDS = new Set([
    "const","let","var","function","return","import","export","default","from",
    "if","else","for","while","class","extends","new","typeof","instanceof",
    "null","undefined","true","false","async","await","of","in","type","interface"
  ]);

  const tokens = [];
  let i = 0;

  while (i < line.length) {
    // String literal
    if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      const q = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== q) {
        if (line[j] === '\\') j++;
        j++;
      }
      j++;
      tokens.push({ cls: 'tok-str', text: line.slice(i, j) });
      i = j;
      continue;
    }
    // Line comment
    if (line[i] === '/' && line[i+1] === '/') {
      tokens.push({ cls: 'tok-comment', text: line.slice(i) });
      break;
    }
    // Word
    if (/[a-zA-Z_$]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[\w$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      tokens.push({ cls: KEYWORDS.has(word) ? 'tok-kw' : null, text: word });
      i = j;
      continue;
    }
    // Number
    if (/\d/.test(line[i])) {
      let j = i;
      while (j < line.length && /[\d.]/.test(line[j])) j++;
      tokens.push({ cls: 'tok-num', text: line.slice(i, j) });
      i = j;
      continue;
    }
    // Everything else
    tokens.push({ cls: null, text: line[i] });
    i++;
  }

  return tokens.map(({ cls, text }) => {
    const esc = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return cls ? `<span class="${cls}">${esc}</span>` : esc;
  }).join('');
}

function HunkHeader({ oldStart, newStart }) {
  return (
    <div className="hunk-header">
      @@ -{oldStart} +{newStart} @@
    </div>
  );
}

function DiffLine({ line }) {
  const { type, text, oldLine, newLine } = line;
  const prefix = type === "removed" ? "−" : type === "added" ? "+" : " ";
  const codeContent = type === "context"
    ? { __html: tokenize(text) }
    : { __html: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") };
  return (
    <div className={`diff-line diff-line--${type}`}>
      <span className="line-num">{oldLine ?? ""}</span>
      <span className="line-num">{newLine ?? ""}</span>
      <span className="line-prefix">{prefix}</span>
      <code className="line-code" dangerouslySetInnerHTML={codeContent} />
    </div>
  );
}

export function GitDiff({ filePath, oldString, newString }) {
  const hunks = renderDiff(oldString, newString);
  const removedCount = (oldString.split("\n").length);
  const addedCount = (newString.split("\n").length);

  return (
    <div className="diff-file">
      <div className="diff-file-header">
        <span className="diff-file-icon">📄</span>
        <span className="diff-file-path">{filePath}</span>
        <span className="diff-stat-added">+{addedCount}</span>
        <span className="diff-stat-removed">−{removedCount}</span>
      </div>
      <div className="diff-body">
        {hunks.length === 0 ? (
          <div className="diff-empty">No changes</div>
        ) : (
          hunks.map((hunk, hi) => {
            const firstOld = hunk.find(l => l.oldLine)?.oldLine ?? 1;
            const firstNew = hunk.find(l => l.newLine)?.newLine ?? 1;
            return (
              <div key={hi}>
                <HunkHeader oldStart={firstOld} newStart={firstNew} />
                {hunk.map((line, li) => <DiffLine key={li} line={line} />)}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
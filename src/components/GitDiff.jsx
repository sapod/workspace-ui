import { useState } from "react";

// ── Core diff renderer ────────────────────────────────────────────────────────

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

function buildRaw(oldLines, newLines, lcs) {
  const raw = [];
  let ai = 0, bi = 0, li = 0;
  while (ai < oldLines.length || bi < newLines.length) {
    const match = lcs[li];
    if (match && match[0] === ai && match[1] === bi) {
      raw.push({ type: "context", text: oldLines[ai], oldLine: ai + 1, newLine: bi + 1 });
      ai++; bi++; li++;
    } else if ((match && match[0] > ai) || (!match && ai < oldLines.length)) {
      raw.push({ type: "removed", text: oldLines[ai], oldLine: ai + 1, newLine: null });
      ai++;
    } else {
      raw.push({ type: "added", text: newLines[bi], oldLine: null, newLine: bi + 1 });
      bi++;
    }
  }
  return raw;
}

function computeRawDiff(oldString, newString) {
  const unescape = s => s.replace(/\\n/g, "\n");
  const oldLines = unescape(oldString).split("\n");
  const newLines = unescape(newString).split("\n");
  const lcs = computeLCS(oldLines, newLines);
  return buildRaw(oldLines, newLines, lcs);
}

function computeInitialRanges(raw, context = 3) {
  const changeIndices = raw
    .map((r, i) => r.type !== "context" ? i : -1)
    .filter(i => i >= 0);
  if (changeIndices.length === 0) return [];

  const ranges = [];
  let current = null;
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - context);
    const end = Math.min(raw.length - 1, idx + context);
    if (!current) { current = { start, end }; }
    else if (start <= current.end + 1) { current.end = Math.max(current.end, end); }
    else { ranges.push(current); current = { start, end }; }
  }
  if (current) ranges.push(current);
  return ranges;
}

function sliceHunks(raw, ranges) {
  return ranges.map(({ start, end }) => raw.slice(start, end + 1));
}

// ── Syntax highlight ──────────────────────────────────────────────────────────

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

// ── Components ────────────────────────────────────────────────────────────────

function ExpandButton({ label, onClick }) {
  return (
    <div className="hunk-expand" onClick={onClick}>
      {label}
    </div>
  );
}

function HunkHeader({ oldStart, oldCount, newStart, newCount }) {
  return (
    <div className="hunk-header">
      @@ -{oldStart},{oldCount} +{newStart},{newCount} @@
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
  const [raw] = useState(() => computeRawDiff(oldString, newString));
  const [ranges, setRanges] = useState(() => computeInitialRanges(raw));

  const hunks = sliceHunks(raw, ranges);

  function expandHunk(index, direction, amount = 10) {
    setRanges(prev => prev.map((r, i) => {
      if (i !== index) return r;
      return {
        start: direction === "up"   ? Math.max(0, r.start - amount) : r.start,
        end:   direction === "down" ? Math.min(raw.length - 1, r.end + amount) : r.end,
      };
    }));
  }

  const removedCount = raw.filter(l => l.type === "removed").length;
  const addedCount   = raw.filter(l => l.type === "added").length;

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
            const range = ranges[hi];
            const firstOld = hunk.find(l => l.oldLine)?.oldLine ?? 1;
            const firstNew = hunk.find(l => l.newLine)?.newLine ?? 1;
            const oldCount = hunk.filter(l => l.type !== "added").length;
            const newCount = hunk.filter(l => l.type !== "removed").length;
            const canExpandUp   = range.start > 0;
            const canExpandDown = range.end < raw.length - 1;
            return (
              <div key={hi}>
                <HunkHeader oldStart={firstOld} oldCount={oldCount} newStart={firstNew} newCount={newCount} />
                {canExpandUp && (
                  <ExpandButton label="↑ Show more" onClick={() => expandHunk(hi, "up")} />
                )}
                {hunk.map((line, li) => <DiffLine key={li} line={line} />)}
                {canExpandDown && (
                  <ExpandButton label="↓ Show more" onClick={() => expandHunk(hi, "down")} />
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
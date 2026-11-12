import { useEffect, useRef, useState } from 'react';

const FF = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";
const FS = '12px';

/**
 * Builds segments from a raw diff array.
 * Each segment is either:
 *   { kind:'removed', text, raw }   — read-only red row
 *   { kind:'real', raws[] }         — editable textarea
 *
 * If no raw diff is provided (plain file view), wraps all lines in one real segment.
 */
function buildSegments(fileContent, raw) {
  if (!raw || raw.length === 0) {
    const lines = fileContent.split('\n');
    const fakeRaws = lines.map((text, i) => ({ kind: 'context', type: 'context', old: i + 1, new_: i + 1, oldLine: i + 1, newLine: i + 1, text }));
    return [{ kind: 'real', raws: fakeRaws }];
  }

  const segments = [];
  let cur = null;
  raw.forEach(r => {
    if (r.type === 'removed') {
      if (cur) { segments.push(cur); cur = null; }
      segments.push({ kind: 'removed', text: r.text, raw: r });
    } else {
      if (!cur) cur = { kind: 'real', raws: [] };
      cur.raws.push(r);
    }
  });
  if (cur) segments.push(cur);
  return segments;
}

/**
 * Measures the rendered height of a single textarea row using a hidden probe.
 * This accounts for any browser-specific internal padding.
 */
function measureRowHeight() {
  const ta = document.createElement('textarea');
  ta.rows = 1;
  ta.value = 'X';
  ta.style.cssText = `font-family:${FF};font-size:${FS};line-height:1.5;position:fixed;visibility:hidden;top:0;left:0;resize:none;border:none;padding:0;margin:0;box-sizing:content-box;overflow:hidden;`;
  document.body.appendChild(ta);
  const h = ta.offsetHeight;
  document.body.removeChild(ta);
  return h;
}

export function FileEditor({ filePath, fileContent, raw, onSave, onClose }) {
  const segments = buildSegments(fileContent, raw);
  const taRefs = useRef({}); // segIdx -> textarea el
  const gutterRef = useRef(null);
  const initialRef = useRef(null);
  const prevTextRef = useRef({});
  const [rowH] = useState(() => measureRowHeight());
  const lineH = rowH; // explicit line-height in px to keep gutter/markers/content aligned
  const [saved, setSaved] = useState(false);
  const [markers, setMarkers] = useState(() => {
    const m = {};
    segments.forEach((seg, si) => {
      if (seg.kind === 'real') {
        m[si] = seg.raws.map(r => r.type === 'added' ? 'added' : 'context');
        prevTextRef.current[si] = seg.raws.map(r => r.text).join('\n');
      }
    });
    return m;
  });

  if (initialRef.current === null) {
    initialRef.current = segments
      .filter(s => s.kind === 'real')
      .map(s => s.raws.map(r => r.text).join('\n'))
      .join('\n');
  }

  // Assign textarea elements to segments
  segments.forEach((seg, i) => {
    if (seg.kind === 'real') seg._idx = i;
  });

  function syncContentWidths() {
    const content = gutterRef.current?.nextElementSibling;
    if (!content) return;
    const containerW = content.parentElement?.clientWidth || 0;
    let maxW = containerW;

    segments.forEach((seg, si) => {
      if (seg.kind === 'removed') {
        const row = content.children[si];
        if (row) {
          row.style.width = 'max-content';
          maxW = Math.max(maxW, row.scrollWidth);
        }
      } else {
        const ta = taRefs.current[si];
        if (ta) {
          ta.style.width = '0px';
          maxW = Math.max(maxW, ta.scrollWidth);
        }
      }
    });

    segments.forEach((seg, si) => {
      if (seg.kind === 'removed') {
        const row = content.children[si];
        if (row) row.style.width = maxW + 'px';
      } else {
        const ta = taRefs.current[si];
        if (!ta) return;
        ta.style.width = maxW + 'px';
        const wrapper = ta.parentElement;
        if (wrapper) {
          wrapper.style.width = maxW + 'px';
          const overlay = wrapper.firstElementChild;
          if (overlay) {
            overlay.style.width = maxW + 'px';
            overlay.style.right = 'auto';
          }
        }
      }
    });
  }

  function rebuildGutter() {
    if (!gutterRef.current) return;
    gutterRef.current.innerHTML = '';
    segments.forEach((seg, si) => {
      if (seg.kind === 'removed') {
        gutterRef.current.appendChild(makeGutterRow(seg.raw.oldLine, '', 'removed', lineH));
      } else {
        const ta = taRefs.current[si];
        const lineCount = ta ? ta.value.split('\n').length : seg.raws.length;
        const segMarkers = markers[si] || [];
        for (let i = 0; i < lineCount; i++) {
          const orig = seg.raws[i];
          gutterRef.current.appendChild(makeGutterRow(
            orig?.oldLine ?? '', orig?.newLine ?? '',
            segMarkers[i] === 'added' ? 'added' : 'context',
            lineH
          ));
        }
      }
    });
    syncContentWidths();
  }

  function makeGutterRow(oldN, newN, kind, h) {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;height:${h}px;flex-shrink:0;box-sizing:border-box`;
    const lnO = document.createElement('span');
    lnO.style.cssText = `min-width:36px;padding:0 6px;text-align:right;color:#484f58;font-size:12px;line-height:${h}px;font-family:monospace`;
    lnO.textContent = oldN ?? '';
    const lnN = document.createElement('span');
    lnN.style.cssText = lnO.style.cssText;
    lnN.textContent = newN ?? '';
    const gm = document.createElement('span');
    gm.style.cssText = `width:14px;text-align:center;font-size:11px;line-height:${h}px;font-weight:600;color:${kind === 'removed' ? '#f85149' : kind === 'added' ? '#3fb950' : 'transparent'}`;
    gm.textContent = kind === 'removed' ? '−' : kind === 'added' ? '+' : ' ';
    row.append(lnO, lnN, gm);
    return row;
  }

  useEffect(() => {
    rebuildGutter();
  });

  function getCurrentContent() {
    return segments
      .filter(s => s.kind === 'real')
      .map(s => taRefs.current[s._idx]?.value ?? s.raws.map(r => r.text).join('\n'))
      .join('\n');
  }

  function handleClose() {
    if (getCurrentContent() !== initialRef.current) {
      if (!window.confirm('Discard unsaved changes?')) return;
    }
    onClose();
  }

  function handleSave() {
    const content = getCurrentContent();
    onSave(filePath, content);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ fontFamily: FF, fontSize: FS, border: '0.5px solid #30363d', borderRadius: 8, overflow: 'hidden', background: '#0d1117', color: '#c9d1d9', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Topbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '0.5px solid #21262d', background: '#161b22', fontFamily: 'sans-serif', fontSize: 12, flexShrink: 0 }}>
        {onClose && (
          <button onClick={handleClose} style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: 13, padding: '0 4px' }}>←</button>
        )}
        <span style={{ color: '#6e7681', fontSize: 11 }}>
          {filePath.split('/').slice(0, -1).join('/').split('/').pop()} /
        </span>
        <span style={{ fontWeight: 500 }}>{filePath.split('/').pop()}</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={handleSave}
          style={{ padding: '4px 12px', border: '0.5px solid #30363d', borderRadius: 6, background: saved ? '#1a2e1a' : 'transparent', color: saved ? '#3fb950' : '#c9d1d9', cursor: 'pointer', fontSize: 12, fontFamily: 'sans-serif', transition: 'all 0.2s' }}
        >
          {saved ? '✓ Saved' : 'Save'}
        </button>
      </div>

      {/* Editor body */}
      <div style={{ display: 'flex', overflow: 'auto', flex: 1 }}>
        {/* Gutter */}
        <div
          ref={gutterRef}
          style={{ flexShrink: 0, background: '#0d1117', borderRight: '0.5px solid #21262d', userSelect: 'none', display: 'flex', flexDirection: 'column' }}
        />

        {/* Content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {segments.map((seg, si) => {
            if (seg.kind === 'removed') {
              return (
                <div
                  key={si}
                  style={{ height: rowH, lineHeight: lineH + 'px', padding: '0 8px', background: '#3d1f1f', color: '#ffa09e', whiteSpace: 'pre', flexShrink: 0, fontFamily: FF, fontSize: FS, boxSizing: 'content-box', minWidth: '100%', width: 'max-content' }}
                >
                  {seg.text}
                </div>
              );
            }
            return (
              <div key={si} style={{ position: 'relative', flexShrink: 0, minWidth: '100%' }}>
                <div
                  aria-hidden="true"
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, pointerEvents: 'none', zIndex: 0 }}
                >
                  {(markers[si] || []).map((m, i) => (
                    <div
                      key={i}
                      style={{
                        height: lineH,
                        width: '100%',
                        background: m === 'added' ? 'rgba(63,185,80,0.18)' : 'transparent',
                        boxSizing: 'border-box',
                      }}
                    />
                  ))}
                </div>
                <textarea
                  ref={el => { if (el) taRefs.current[si] = el; }}
                  rows={seg.raws.length}
                  spellCheck={false}
                  defaultValue={seg.raws.map(r => r.text).join('\n')}
                  onChange={e => {
                    const newVal = e.target.value;
                    const newLines = newVal.split('\n');
                    e.target.rows = newLines.length;

                    const oldVal = prevTextRef.current[si] ?? '';
                    const oldLines = oldVal.split('\n');
                    if (newLines.length !== oldLines.length) {
                      let nextMarkers = null;
                      if (newLines.length === oldLines.length + 1) {
                        let i = 0;
                        while (i < oldLines.length && oldLines[i] === newLines[i]) i++;
                        let j = oldLines.length - 1, k = newLines.length - 1;
                        while (j >= i && oldLines[j] === newLines[k]) { j--; k--; }
                        if (i === k) {
                          const cur = (markers[si] || []).slice();
                          cur.splice(i, 0, 'added');
                          nextMarkers = cur;
                        }
                      } else if (newLines.length === oldLines.length - 1) {
                        let i = 0;
                        while (i < newLines.length && oldLines[i] === newLines[i]) i++;
                        let j = oldLines.length - 1, k = newLines.length - 1;
                        while (k >= i && oldLines[j] === newLines[k]) { j--; k--; }
                        if (i === j) {
                          const cur = (markers[si] || []).slice();
                          cur.splice(i, 1);
                          nextMarkers = cur;
                        }
                      }
                      if (nextMarkers) {
                        setMarkers(prev => ({ ...prev, [si]: nextMarkers }));
                      } else {
                        setMarkers(prev => ({ ...prev, [si]: newLines.map(() => 'context') }));
                      }
                    }
                    prevTextRef.current[si] = newVal;
                    rebuildGutter();
                  }}
                  style={{
                    position: 'relative', zIndex: 1,
                    fontFamily: FF, fontSize: FS, lineHeight: lineH + 'px',
                    display: 'block', minWidth: '100%',
                    border: 'none', outline: 'none', resize: 'none', overflow: 'hidden',
                    whiteSpace: 'pre', padding: '0 8px', margin: 0,
                    background: 'transparent', color: '#c9d1d9', caretColor: '#c9d1d9',
                    flexShrink: 0, boxSizing: 'content-box',
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
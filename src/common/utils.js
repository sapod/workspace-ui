const BASE = "";

async function parseResponse(r) {
  const text = await r.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || data?.message || text || `HTTP ${r.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

export async function fetchJson(url) {
  const r = await fetch(BASE + url);
  return parseResponse(r);
}

export async function fetchJsonAbsolute(url) {
  const r = await fetch(url);
  return parseResponse(r);
}

export async function postJsonAbsolute(url, data) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return parseResponse(r);
}
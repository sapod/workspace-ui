const BASE = "";

export async function fetchJson(url) {
  const r = await fetch(BASE + url);
  return r.json();
}

export async function fetchJsonAbsolute(url) {
  const r = await fetch(url);
  return r.json();
}

export async function postJsonAbsolute(url, data) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json();
}
const BASE = "";

export async function fetchJson(url) {
  const r = await fetch(BASE + url);
  return r.json();
}

export async function fetchJsonAbsolute(url) {
  const r = await fetch(url);
  return r.json();
}
const API = '/api';

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `HTTP ${res.status}`;
    if (raw) {
      try {
        const j = JSON.parse(raw);
        message = j?.message || j?.error?.message || j?.error || j?.data?.message || `${message}: ${raw.slice(0, 300)}`;
      } catch {
        message = `${message}: ${raw.slice(0, 300)}`;
      }
    }
    const err = new Error(message);
    err.status = res.status;
    console.error(`[opencode] ${method} ${path} -> ${message}`);
    throw err;
  }

  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function toModelRef(model) {
  if (!model) return null;
  const providerID = model.providerID ?? model.provider;
  const id = model.id ?? model.name ?? model.modelID;
  if (!providerID || !id) return null;
  const ref = { providerID, id };
  if (model.variant) ref.variant = model.variant;
  return ref;
}

function normalizeContentPart(part, typeIndex) {
  if (part.type === 'text') {
    return { id: `text-${typeIndex}`, type: 'text', text: part.text ?? '' };
  }
  if (part.type === 'reasoning') {
    return { id: `reasoning-${typeIndex}`, type: 'reasoning', text: part.text ?? '', time: part.time };
  }
  if (part.type === 'tool') {
    return {
      id: part.id,
      type: 'tool',
      tool: part.name,
      state: part.state,
      executed: part.executed,
      time: part.time,
    };
  }
  return { id: `part-${typeIndex}`, ...part };
}

function normalizeMessage(message) {
  if (!message) return null;

  if (message.type === 'user') {
    return {
      info: { id: message.id, role: 'user', time: message.time, metadata: message.metadata },
      parts: [{ id: 'text', type: 'text', text: message.text ?? '' }],
    };
  }

  if (message.type === 'assistant') {
    const counts = { text: 0, reasoning: 0 };
    const content = Array.isArray(message.content) ? message.content : [];
    const parts = content.map((part, position) => {
      const index = part.type === 'text' || part.type === 'reasoning' ? counts[part.type]++ : position;
      return normalizeContentPart(part, index);
    });
    return {
      info: {
        id: message.id,
        role: 'assistant',
        time: message.time,
        agent: message.agent,
        model: message.model,
        finish: message.finish,
        error: message.error,
        cost: message.cost,
        tokens: message.tokens,
      },
      parts,
    };
  }

  if (message.type === 'system' || message.type === 'synthetic' || message.type === 'compaction') {
    const content = Array.isArray(message.content) ? message.content : [];
    const text = message.text ?? content.map((c) => c.text ?? '').join('\n');
    if (!text) return null;
    return {
      info: { id: message.id, role: 'system', time: message.time },
      parts: [{ id: 'text', type: 'text', text }],
    };
  }

  return null;
}

async function openEventStream() {
  const res = await fetch(`${API}/event`, {
    headers: { Accept: 'text/event-stream' },
    cache: 'no-store',
  });
  if (!res.ok || !res.body) {
    throw new Error(`Event stream failed (HTTP ${res.status})`);
  }
  return res.body.getReader();
}

async function* readEvents(reader) {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');

      if (!data) continue;
      try {
        yield JSON.parse(data);
      } catch {
        // ignore malformed/partial payloads
      }
    }
  }
}

function createEventHandler(sessionID, handlers = {}) {
  const tools = new Map();

  function toolKey(messageID, id) {
    return `${messageID}:${id}`;
  }

  function emitTool(messageID, id, name, state, extra = {}) {
    handlers.onPart?.(messageID, {
      id,
      type: 'tool',
      tool: name || tools.get(toolKey(messageID, id))?.name || 'tool',
      state,
      ...extra,
    });
  }

  return (event) => {
    const type = event?.type;
    const data = event?.data ?? {};

    if (data.sessionID && data.sessionID !== sessionID) return null;

    switch (type) {
      case 'session.step.started':
        handlers.onMessage?.({
          id: data.assistantMessageID,
          role: 'assistant',
          agent: data.agent,
          model: data.model,
          time: { created: data.started },
        });
        break;

      case 'session.text.started':
        handlers.onPart?.(data.assistantMessageID, {
          id: `text-${data.ordinal}`,
          type: 'text',
          text: '',
        });
        break;

      case 'session.text.delta':
        handlers.onDelta?.(data.assistantMessageID, `text-${data.ordinal}`, 'text', data.delta);
        break;

      case 'session.text.ended':
        handlers.onPart?.(data.assistantMessageID, {
          id: `text-${data.ordinal}`,
          type: 'text',
          text: data.text ?? '',
          time: { end: Date.now() },
        });
        break;

      case 'session.reasoning.started':
        handlers.onPart?.(data.assistantMessageID, {
          id: `reasoning-${data.ordinal}`,
          type: 'reasoning',
          text: '',
        });
        break;

      case 'session.reasoning.delta':
        handlers.onDelta?.(data.assistantMessageID, `reasoning-${data.ordinal}`, 'reasoning', data.delta);
        break;

      case 'session.reasoning.ended':
        handlers.onPart?.(data.assistantMessageID, {
          id: `reasoning-${data.ordinal}`,
          type: 'reasoning',
          text: data.text ?? '',
          time: { end: Date.now() },
        });
        break;

      case 'session.tool.input.started':
        tools.set(toolKey(data.assistantMessageID, data.id), { name: data.name, raw: '' });
        emitTool(data.assistantMessageID, data.id, data.name, { status: 'streaming', input: '' });
        break;

      case 'session.tool.input.delta': {
        const key = toolKey(data.assistantMessageID, data.id);
        const entry = tools.get(key) ?? { name: data.name, raw: '' };
        entry.raw += data.delta ?? '';
        tools.set(key, entry);
        emitTool(data.assistantMessageID, data.id, entry.name ?? data.name, {
          status: 'streaming',
          input: entry.raw,
        });
        break;
      }

      case 'session.tool.input.ended': {
        const key = toolKey(data.assistantMessageID, data.id);
        const entry = tools.get(key) ?? { name: data.name, raw: '' };
        entry.raw = data.text ?? '';
        try {
          entry.input = JSON.parse(entry.raw);
        } catch {
          entry.input = undefined;
        }
        tools.set(key, entry);
        emitTool(data.assistantMessageID, data.id, entry.name ?? data.name, {
          status: 'streaming',
          input: entry.input ?? entry.raw,
        });
        break;
      }

      case 'session.tool.called': {
        const key = toolKey(data.assistantMessageID, data.id);
        const entry = tools.get(key) ?? {};
        entry.input = data.input;
        tools.set(key, entry);
        emitTool(data.assistantMessageID, data.id, entry.name, {
          status: 'running',
          input: data.input,
          metadata: {},
        }, { executed: data.executed });
        break;
      }

      case 'session.tool.success': {
        const key = toolKey(data.assistantMessageID, data.id);
        const entry = tools.get(key) ?? {};
        emitTool(data.assistantMessageID, data.id, entry.name, {
          status: 'completed',
          input: entry.input,
          content: data.content ?? [],
          metadata: data.metadata ?? {},
        }, { executed: data.executed });
        break;
      }

      case 'session.tool.failed': {
        const key = toolKey(data.assistantMessageID, data.id);
        const entry = tools.get(key) ?? {};
        emitTool(data.assistantMessageID, data.id, entry.name, {
          status: 'error',
          input: entry.input,
          error: data.error,
          content: data.content ?? [],
        }, { executed: data.executed });
        break;
      }

      case 'session.step.ended':
        handlers.onMessage?.({
          id: data.assistantMessageID,
          role: 'assistant',
          finish: data.finish,
          tokens: data.tokens,
          cost: data.cost,
        });
        break;

      case 'session.step.failed':
        handlers.onMessage?.({
          id: data.assistantMessageID,
          role: 'assistant',
          finish: 'error',
          error: data.error,
        });
        break;

      case 'session.execution.interrupted':
      case 'session.execution.succeeded':
      case 'session.execution.failed':
        return 'done';

      default:
        break;
    }

    return null;
  };
}

async function consumeEvents(reader, sessionID, handlers) {
  const handle = createEventHandler(sessionID, handlers);
  for await (const event of readEvents(reader)) {
    if (handle(event) === 'done') break;
  }
}

class OpencodeService {
  async health() {
    try {
      const info = await request('/info');
      return { ok: true, version: info?.version ?? '?' };
    } catch {
      return { ok: false };
    }
  }

  async listSessions() {
    const r = await request('/session?limit=200');
    return r?.data ?? [];
  }

  async getSession(id) {
    const r = await request(`/session/${encodeURIComponent(id)}`);
    return r?.data ?? r;
  }

  async isSessionRunning(id) {
    try {
      const s = await this.getSession(id);
      const busy = s?.time?.busy;
      const idle = s?.time?.idle;
      return busy != null && (idle == null || busy > idle);
    } catch {
      return false;
    }
  }

  async createSession(title, { directory, model } = {}) {
    const body = { title };
    if (directory) {
      // The V2 server returns a blank 500 for relative/`~` locations, so only
      // ever send a resolved absolute path.
      if (typeof directory !== 'string' || !directory.startsWith('/')) {
        throw new Error(`Invalid session directory "${directory}" — an absolute path is required`);
      }
      body.location = { directory };
    }
    const ref = toModelRef(model);
    if (ref) body.model = ref;
    const r = await request('/session', { method: 'POST', body });
    return r?.data ?? r;
  }

  async deleteSession(id) {
    return request(`/session/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async abortSession(id) {
    return request(`/session/${encodeURIComponent(id)}/interrupt`, { method: 'POST' });
  }

  async setModel(id, model) {
    const ref = toModelRef(model);
    if (!ref) return null;
    return request(`/session/${encodeURIComponent(id)}/model`, {
      method: 'POST',
      body: { model: ref },
    });
  }

  async forkSession(id) {
    const r = await request(`/session/${encodeURIComponent(id)}/fork`, {
      method: 'POST',
      body: { before: null },
    });
    return r?.data ?? r;
  }

  async listMessages(id) {
    let path = `/session/${encodeURIComponent(id)}/message?limit=200&order=asc`;
    const messages = [];
    const seen = new Set();

    // The messages endpoint caps `limit` at 200 and paginates with an opaque cursor.
    for (let page = 0; page < 50; page++) {
      const r = await request(path);
      const batch = Array.isArray(r) ? r : (r?.data ?? []);
      for (const message of batch) {
        const normalized = normalizeMessage(message);
        if (normalized && !seen.has(normalized.info.id)) {
          seen.add(normalized.info.id);
          messages.push(normalized);
        }
      }
      const next = r?.cursor?.next;
      if (!next || batch.length === 0) break;
      path = `/session/${encodeURIComponent(id)}/message?cursor=${encodeURIComponent(next)}`;
    }

    return messages;
  }

  async sendMessage(id, text, { model, resume = true, handlers = {} } = {}) {
    // Never enqueue without a reply stream: the primer message uses resume:false.
    if (!resume) {
      if (model) await this.setModel(id, model);
      return request(`/session/${encodeURIComponent(id)}/prompt`, {
        method: 'POST',
        body: { text, resume: false },
      });
    }

    const reader = await openEventStream();
    try {
      if (model) await this.setModel(id, model);
      await request(`/session/${encodeURIComponent(id)}/prompt`, {
        method: 'POST',
        body: { text, resume: true },
      });
      await consumeEvents(reader, id, handlers);
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
  }

  async subscribeToSession(id, handlers = {}) {
    // Attach before checking state so an execution that finishes between the
    // check and the stream read still has its terminal event captured.
    const reader = await openEventStream();
    try {
      let running = await this.isSessionRunning(id);
      if (!running) {
        // The session may have just started; re-check once before giving up.
        await new Promise((resolve) => setTimeout(resolve, 50));
        running = await this.isSessionRunning(id);
      }
      if (!running) return false;
      await consumeEvents(reader, id, handlers);
      return true;
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
  }

  async getPath() {
    const res = await fetch('/path');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async listFiles(path) {
    const res = await fetch(`/files?path=${encodeURIComponent(path || '')}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async listModels() {
    const r = await request('/model?types=chat');
    const list = Array.isArray(r) ? r : (r?.data ?? []);
    return list
      .filter((m) => m.enabled !== false)
      .map((m) => {
        const name = m.modelID ?? m.id;
        return {
          provider: m.providerID,
          name,
          label: m.name ?? name,
          variants: (m.variants ?? []).map((v) => v.id),
        };
      });
  }

}

const oc = new OpencodeService();
export default oc;
export { OpencodeService };

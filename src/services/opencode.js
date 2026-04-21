import { createOpencodeClient } from "@opencode-ai/sdk"
import { fetchJson } from '../common/utils';

async function subscribeEvents() {
  const response = await fetch(`http://${window.location.hostname}:4096/event`, {
    headers: { 'Accept': 'text/event-stream' }
  })

  const reader = response.body?.getReader()
  return reader;
}

async function handleEvents(reader, onDelta, onPart, onMessage) {
  const decoder = new TextDecoder();
  const maxHeartbeatsToWait = 3;
  let heartbeatCount = 0;
  let exit = false;
  const messageRoles = {}
  const messagePartTypes = {}
  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    const chunk = decoder.decode(value)

    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try {
        const event = JSON.parse(line.slice(6))
        if (event.type === 'server.heartbeat') {
          heartbeatCount ++;
          if (heartbeatCount > maxHeartbeatsToWait) {
            reader.cancel();
            exit = true;
            break;
          }
        }
        else if (event.type === 'session.idle' || (event.type == 'session.status' && event.properties.status == 'idle')) {
          reader.cancel();
          exit = true;
          break
        }
        else if (event.type === 'message.updated') {
          const { info } = event.properties
          messageRoles[info.id] = info.role
          onMessage?.(info)
        }
        else if (event.type === 'message.part.updated') {
          const { part } = event.properties
          messagePartTypes[part.id] = part.type
          onPart?.(part.messageID, part)
        }
        else if (event.type === 'message.part.delta' && event.properties.field === 'text') {
          const role = messageRoles[event.properties.messageID]
          const partType = messagePartTypes[event.properties.partID]
          const { messageID, partID, field, delta } = event.properties
          if (field === 'text' && (partType === 'text' || partType === 'reasoning')) {
            onDelta?.(messageID, partID, delta)
          }
          heartbeatCount = 0;
        }
      } catch {
        // partial line, ignore
      }
    }

    if (exit) break;
  }
}

class OpencodeService {
  constructor() {
    this._client = createOpencodeClient({
      baseUrl: "/",
    });
  }

  async health() {
    try {
      const r = await this._client.session.list();
      const version = r.data?.[0]?.version || '?';
      return { ok: true, version };
    } catch {
      return { ok: false };
    }
  }

  async listSessions() {
    const r = await this._client.session.list();
    return r.data ?? [];
  }

  async getSession(id) {
    const r = await this._client.session.get({ id });
    return r.data;
  }

  async createSession(title) {
    const r = await this._client.session.create({ title: title });
    return r.data;
  }

  async deleteSession(id) {
    return await this._client.session.delete({ id });
  }

  async abortSession(id) {
    return await this._client.session.abort({ path: { id } });
  }

  async forkSession(id) {
    const r = await this._client.session.fork({ id });
    return r.data;
  }

  async listMessages(id) {
    const r = await this._client.session.messages({
      path: { id },
    });
    return r.data ?? [];
  }

  async sendMessage(id, parts, model, noReply = false, onDelta, onPart, onMessage) {
    const body = { parts, noReply };
    if (model) body.model = model;

    const reader = !noReply ? await subscribeEvents() : null;

    this._client.session.prompt({
      path: { id },
      body,
    });

    if (!noReply){
      await handleEvents(reader, onDelta, onPart, onMessage);
    }
  }

  async getPath() {
    return fetchJson('/path');
  }

  async listFiles(path) {
    const r = await fetch(`/files?path=${encodeURIComponent(path || '')}`);
    return r.json();
  }

  async listModels() {
    try {
      const r = await this._client.config.providers();
      const provs = r.data?.providers ?? [];
      const models = [];
      for (const p of provs) {
        const pModels = p.models ? Object.keys(p.models) : [];
        for (const m of pModels) {
          models.push({ provider: p.id, name: m });
        }
      }
      return models;
    } catch {
      await this._client.tui.openModels();
      return [];
    }
  }

  getEventUrl() {
    return "/global/event";
  }
}

const oc = new OpencodeService();
export default oc;
export { OpencodeService };
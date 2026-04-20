import { createOpencodeClient } from "@opencode-ai/sdk"

const BASE = "";

async function fetchJson(url) {
  const r = await fetch(BASE + url);
  return r.json();
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
    } catch (e) {
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
    return await this._client.session.abort({ id });
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

  async sendMessage(id, parts, model) {
    const body = { parts };
    if (model) body.model = model;
    const r = await this._client.session.prompt({
      path: { id },
      body,
    });
    return r.data;
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
    } catch (e) {
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
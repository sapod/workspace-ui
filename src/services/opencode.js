class OpencodeService {
  constructor() {
    this._client = null;
  }

  get client() {
    if (!this._client) {
      this._client = this._createClient();
    }
    return this._client;
  }

  _createClient() {
    return {
      async health() {
        const r = await fetch('/global/health');
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },

      async listSessions() {
        const r = await fetch('/session');
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },

      async getSession(id) {
        const r = await fetch('/session/' + id);
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },

      async createSession(title) {
        const r = await fetch('/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title })
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },

      async deleteSession(id) {
        const r = await fetch('/session/' + id, { method: 'DELETE' });
        if (!r.ok) throw new Error(await r.text());
        return true;
      },

      async abortSession(id) {
        const r = await fetch('/session/' + id + '/abort', { method: 'POST' });
        if (!r.ok) throw new Error(await r.text());
        return true;
      },

      async forkSession(id) {
        const r = await fetch('/session/' + id + '/fork', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },

      async listMessages(id) {
        const r = await fetch('/session/' + id + '/message');
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },

      async sendMessage(id, parts) {
        const r = await fetch('/session/' + id + '/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parts })
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },

      async getPath() {
        const r = await fetch('/path');
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },

      async listFiles(path) {
        const r = await fetch('/file?path=' + encodeURIComponent(path || ''));
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },

      getEventUrl() {
        return '/global/event';
      }
    };
  }

  async health() {
    return this.client.health();
  }

  async listSessions() {
    return this.client.listSessions();
  }

  async getSession(id) {
    return this.client.getSession(id);
  }

  async createSession(title) {
    return this.client.createSession(title);
  }

  async deleteSession(id) {
    return this.client.deleteSession(id);
  }

  async abortSession(id) {
    return this.client.abortSession(id);
  }

  async forkSession(id) {
    return this.client.forkSession(id);
  }

  async listMessages(id) {
    return this.client.listMessages(id);
  }

  async sendMessage(id, parts) {
    return this.client.sendMessage(id, parts);
  }

  async getPath() {
    return this.client.getPath();
  }

  async listFiles(path) {
    return this.client.listFiles(path);
  }

  getEventUrl() {
    return this.client.getEventUrl();
  }
}

const oc = new OpencodeService();
export default oc;
export { OpencodeService };
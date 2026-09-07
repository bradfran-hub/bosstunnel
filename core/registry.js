"use strict";
const { validateAdapter } = require("./model");
class SourceRegistry {
  constructor(graph, { maxClients = 32 } = {}) { this.graph = graph; this.factories = new Map(); this.clients = new Map(); this.maxClients = maxClients; }
  register(protocol, factory) {
    if (this.factories.has(protocol)) throw new Error(`Source protocol already registered: ${protocol}`);
    this.factories.set(protocol, factory);
  }
  async get(sourceId) {
    const source = this.graph.source(sourceId, { credentials: true });
    if (!source?.enabled) throw Object.assign(new Error("Source is disabled or unavailable"), { code: "SOURCE_DISABLED" });
    const key = `${sourceId}:${source.revision}`;
    if (!this.clients.has(key)) {
      const factory = this.factories.get(source.protocol);
      if (!factory) throw new Error(`Source protocol is not installed: ${source.protocol}`);
      const promise = Promise.resolve().then(() => factory(source)).then(validateAdapter);
      this.clients.set(key, promise);
      promise.catch(() => this.clients.delete(key));
      while (this.clients.size > this.maxClients) this.clients.delete(this.clients.keys().next().value);
    }
    const value = this.clients.get(key); this.clients.delete(key); this.clients.set(key, value);
    return value;
  }
  invalidate(sourceId) { for (const key of this.clients.keys()) if (key.startsWith(`${sourceId}:`)) this.clients.delete(key); }
}
module.exports = { SourceRegistry };

"use strict";
const { validateAdapter } = require("./model");
class SourceRegistry {
  constructor(graph, { maxClients = 32 } = {}) { this.graph = graph; this.factories = new Map(); this.clients = new Map(); this.listeners = new Map(); this.maxClients = maxClients; }
  register(protocol, factory) {
    if (this.factories.has(protocol)) throw new Error(`Source protocol already registered: ${protocol}`);
    this.factories.set(protocol, factory);
  }
  async get(sourceId) {
    const access = this.graph.sourceAccess(sourceId);
    const source = this.graph.source(sourceId, { credentials: true });
    if (!source?.enabled) throw Object.assign(new Error("Source is disabled or unavailable"), { code: "SOURCE_DISABLED" });
    const key = `${sourceId}:${source.revision}`;
    if (!this.clients.has(key)) {
      const factory = this.factories.get(source.protocol);
      if (!factory) throw new Error(`Source protocol is not installed: ${source.protocol}`);
      const publicOnly = Boolean(this.graph.sql("SELECT 1 FROM CustomerSources WHERE source_id=?").get(sourceId));
      const network = require("./network");
      const promise = require("./abortable").abortable(Promise.resolve().then(() => network.scoped(publicOnly, () => factory(source), access)).then(validateAdapter).then(adapter => {
        access?.assertCurrent();
        return network.wrapAdapter(adapter, publicOnly, access);
      }), access?.signal);
      this.clients.set(key, promise);
      const remove = () => { if (this.clients.get(key) === promise) this.drop(key); };
      access?.signal.addEventListener("abort", remove, { once: true });
      if (access) this.listeners.set(key, () => access.signal.removeEventListener("abort", remove));
      promise.catch(remove);
      while (this.clients.size > this.maxClients) this.drop(this.clients.keys().next().value);
    }
    const value = this.clients.get(key); this.clients.delete(key); this.clients.set(key, value);
    const adapter = await value;
    access?.assertCurrent();
    return adapter;
  }
  drop(key) { this.clients.delete(key); this.listeners.get(key)?.(); this.listeners.delete(key); }
  invalidate(sourceId) { for (const key of this.clients.keys()) if (key.startsWith(`${sourceId}:`)) this.drop(key); }
}
module.exports = { SourceRegistry };

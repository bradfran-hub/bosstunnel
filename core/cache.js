"use strict";

class BoundedCache {
  constructor({ maxEntries = 1000, maxBytes = 8 * 1024 * 1024, clock = Date.now } = {}) {
    this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.clock = clock;
    this.values = new Map(); this.bytes = 0;
  }
  get(key) {
    const hit = this.values.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.clock()) { this.delete(key); return undefined; }
    this.values.delete(key); this.values.set(key, hit);
    return hit.value;
  }
  set(key, value, ttlMs) {
    this.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(String(key));
    if (ttlMs <= 0 || bytes > this.maxBytes) return;
    this.values.set(key, { value, bytes, expires: this.clock() + ttlMs }); this.bytes += bytes;
    while (this.values.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.values.keys().next().value);
  }
  delete(key) { const hit = this.values.get(key); if (hit) this.bytes -= hit.bytes; this.values.delete(key); }
  clear() { this.values.clear(); this.bytes = 0; }
  invalidatePrefix(prefix) { for (const key of this.values.keys()) if (String(key).startsWith(prefix)) this.delete(key); }
}
function createCaches() {
  return Object.fromEntries(["metadata", "artwork", "identity", "catalogPages", "sourceResponses", "resolution"].map((name) => [name, new BoundedCache({ maxBytes: name === "sourceResponses" ? 16 * 1024 * 1024 : 4 * 1024 * 1024 })]));
}
function sourceCaches(graph, sourceId, caches) {
  const access = graph.sourceAccess(sourceId);
  if (!access) return caches;
  const crypto = require("node:crypto");
  return Object.fromEntries(Object.entries(caches).map(([name, cache]) => {
    const cacheKey = key => `${sourceId}:vault:${crypto.createHash("sha256").update(JSON.stringify([name, key])).digest("hex")}`;
    return [name, {
      get(key) {
        access.assertCurrent();
        const storedKey = cacheKey(key), value = cache.get(storedKey);
        return value === undefined ? undefined : graph.sourceOpen(sourceId, "source-cache", storedKey, value);
      },
      set(key, value, ttlMs) {
        access.assertCurrent();
        const storedKey = cacheKey(key);
        cache.set(storedKey, graph.sourceSeal(sourceId, "source-cache", storedKey, value), ttlMs);
      },
      delete(key) { access.assertCurrent(); cache.delete(cacheKey(key)); }
    }];
  }));
}
module.exports = { BoundedCache, createCaches, sourceCaches };

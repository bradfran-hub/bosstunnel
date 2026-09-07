"use strict";
class WorkLimiter {
  constructor({ concurrency = 16, maxQueued = 128, waitMs = 15000 } = {}) {
    this.concurrency = concurrency; this.maxQueued = maxQueued; this.waitMs = waitMs;
    this.active = 0; this.queue = []; this.closed = false;
  }
  acquire() {
    if (this.closed) return Promise.reject(new Error("Resolver is shutting down"));
    if (this.active < this.concurrency) { this.active++; return Promise.resolve(); }
    if (this.queue.length >= this.maxQueued) return Promise.reject(new Error("Resolver queue is full"));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      entry.timer = setTimeout(() => { const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1); reject(new Error("Resolver queue timed out")); }, this.waitMs);
      this.queue.push(entry);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else this.active--;
  }
  async run(task) { await this.acquire(); try { return await task(); } finally { this.release(); } }
  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) { clearTimeout(entry.timer); entry.reject(new Error("Resolver is shutting down")); }
  }
}
module.exports = { WorkLimiter };

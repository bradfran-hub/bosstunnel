"use strict";
class WorkLimiter {
  constructor({ concurrency = 16, maxQueued = 128, waitMs = 15000 } = {}) {
    this.concurrency = concurrency; this.maxQueued = maxQueued; this.waitMs = waitMs;
    this.active = 0; this.queue = []; this.closed = false;
  }
  acquire({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new Error("Resolver is shutting down"));
    if (this.active < this.concurrency) { this.active++; return Promise.resolve(); }
    if (this.queue.length >= this.maxQueued) return Promise.reject(new Error("Resolver queue is full"));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      const remove = error => { const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1); entry.cleanup(); reject(error); };
      const abort = () => remove(signal.reason);
      entry.cleanup = () => { clearTimeout(entry.timer); signal?.removeEventListener("abort", abort); };
      entry.timer = setTimeout(() => remove(new Error("Resolver queue timed out")), this.waitMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) { next.cleanup(); next.resolve(); }
    else this.active--;
  }
  async run(task, options = {}) { await this.acquire(options); try { options.signal?.throwIfAborted(); return await task(); } finally { this.release(); } }
  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) { entry.cleanup(); entry.reject(new Error("Resolver is shutting down")); }
  }
}
module.exports = { WorkLimiter };

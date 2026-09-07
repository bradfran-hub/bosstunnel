"use strict";
const { createHash } = require("node:crypto");

function retrySeconds(value, now = Date.now()) {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const seconds = Number(value.trim());
    if (Number.isSafeInteger(seconds) && seconds <= (Number.MAX_SAFE_INTEGER - now) / 1000) return Math.max(1, seconds);
  }
  const date = typeof value === "string" && /[A-Za-z]/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : 60;
}

class PlaybackBackoff {
  constructor({ clock = Date.now, limit = 1024 } = {}) { this.clock = clock; this.limit = limit; this.entries = new Map(); }
  key(scope, url) { return createHash("sha256").update(JSON.stringify([scope, new URL(url).origin])).digest("hex"); }
  check(scope, url) {
    const key = this.key(scope, url), until = this.entries.get(key);
    if (!until) return;
    if (until <= this.clock()) { this.entries.delete(key); return; }
    throw this.error(Math.ceil((until - this.clock()) / 1000));
  }
  error(seconds) { return Object.assign(new Error("Playback source is temporarily rate limited. Retry later."), { status: 429, upstreamStatus: 429, retryAfter: seconds, refreshPlayback: false }); }
  record(scope, url, value) {
    const now = this.clock(), seconds = retrySeconds(value, now);
    for (const [key, until] of this.entries) if (until <= now) this.entries.delete(key);
    const key = this.key(scope, url);
    if (!this.entries.has(key) && this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, Math.max(this.entries.get(key) || 0, now + seconds * 1000));
    return this.error(Math.ceil((this.entries.get(key) - now) / 1000));
  }
}
module.exports = { PlaybackBackoff, retrySeconds };

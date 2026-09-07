"use strict";
class AuthLimit {
  constructor({ failures = 30, windowMs = 60000, maximumPeers = 1024, clock = Date.now } = {}) {
    this.failures = failures; this.windowMs = windowMs; this.maximumPeers = maximumPeers; this.clock = clock; this.peers = new Map();
  }
  check(peer) {
    const now = this.clock();
    for (const [key, state] of this.peers) if (state.until <= now) this.peers.delete(key);
    const state = this.peers.get(peer);
    if (state?.count >= this.failures) return Math.max(1, Math.ceil((state.until - now) / 1000));
    if (!state && this.peers.size >= this.maximumPeers) return Math.max(1, Math.ceil(Math.min(...Array.from(this.peers.values(), (entry) => entry.until - now)) / 1000));
    return 0;
  }
  failed(peer) {
    const state = this.peers.get(peer);
    if (state) state.count++;
    else if (this.peers.size < this.maximumPeers) this.peers.set(peer, { count: 1, until: this.clock() + this.windowMs });
  }
  succeeded(peer) { this.peers.delete(peer); }
}
module.exports = { AuthLimit };

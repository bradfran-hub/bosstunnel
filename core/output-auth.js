"use strict";
const crypto = require("node:crypto");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const error = (message, status = 401) => Object.assign(new Error(message), { status });
const validProtocol = protocol => {
  if (!["jellyfin", "emby", "plex"].includes(protocol)) throw error("Unsupported output authentication protocol", 400);
};

class OutputAuth {
  constructor(graph, { ttlMs = 86400000, maxSessions = 32 } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 86400000 || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 100) throw error("Invalid output session limits", 400);
    this.graph = graph; this.ttlMs = ttlMs; this.maxSessions = maxSessions;
  }
  collection(id) {
    const collection = this.graph.collection(id);
    if (!collection?.sourceIds.length) throw error("Output access is unavailable");
    this.graph.collectionAccess(id, { includeSignal: false }).assertCurrent();
    return collection;
  }
  provision(collectionId, protocol) {
    validProtocol(protocol); this.collection(collectionId);
    if (this.account(collectionId, protocol)) throw error("Output account already exists", 409);
    const password = crypto.randomBytes(32).toString("base64url");
    const username = crypto.randomBytes(12).toString("hex"), userId = crypto.randomUUID().replaceAll("-", "");
    this.graph.sql("INSERT INTO OutputAccounts(collection_id,protocol,username,user_id,password_hash,created_at) VALUES(?,?,?,?,?,?)").run(collectionId, protocol, username, userId, hash(password), this.graph.clock());
    return { username, password, userId };
  }
  account(collectionId, protocol) {
    return this.graph.sql("SELECT * FROM OutputAccounts WHERE collection_id=? AND protocol=?").get(collectionId, protocol);
  }
  rotate(collectionId, protocol) {
    validProtocol(protocol); this.collection(collectionId);
    const account = this.account(collectionId, protocol);
    if (!account) throw error("Output account not found", 404);
    const password = crypto.randomBytes(32).toString("base64url");
    this.graph.db.transaction(() => {
      this.graph.sql("UPDATE OutputAccounts SET password_hash=?,revision=revision+1 WHERE collection_id=? AND protocol=?").run(hash(password), collectionId, protocol);
      this.graph.sql("DELETE FROM OutputSessions WHERE collection_id=? AND protocol=?").run(collectionId, protocol);
    })();
    return { username: account.username, password, userId: account.user_id };
  }
  authenticate(protocol, username, password, { deviceId } = {}) {
    validProtocol(protocol);
    if (typeof username !== "string" || username.length > 128 || typeof password !== "string" || password.length > 256 || typeof deviceId !== "string" || !deviceId.trim() || deviceId.length > 256) throw error("Invalid output credentials or device");
    const account = this.graph.sql("SELECT * FROM OutputAccounts WHERE protocol=? AND username=?").get(protocol, username);
    const digest = Buffer.from(hash(password), "hex");
    if (!crypto.timingSafeEqual(digest, Buffer.from(account?.password_hash || "0".repeat(64), "hex")) || !account) throw error("Invalid output credentials or device");
    const collection = this.collection(account.collection_id);
    const now = this.graph.clock(), expiresAt = now + this.ttlMs;
    const token = crypto.randomBytes(32).toString("base64url");
    this.graph.db.transaction(() => {
      this.graph.sql("DELETE FROM OutputSessions WHERE expires_at<=?").run(now);
      this.graph.sql("DELETE FROM OutputSessions WHERE collection_id=? AND protocol=? AND (device_id=? OR account_revision<>? OR collection_revision<>?)").run(collection.id, protocol, hash(deviceId), account.revision, collection.revision);
      if (this.graph.sql("SELECT count(*) AS n FROM OutputSessions WHERE collection_id=? AND protocol=?").get(collection.id, protocol).n >= this.maxSessions) throw error("Output session limit reached", 429);
      this.graph.sql("INSERT INTO OutputSessions VALUES(?,?,?,?,?,?,?,?)").run(hash(token), collection.id, protocol, account.revision, collection.revision, hash(deviceId), now, expiresAt);
    })();
    return { token, expiresAt, userId: account.user_id, collectionId: collection.id, name: collection.name };
  }
  verify(protocol, token) {
    validProtocol(protocol);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw error("Invalid output session");
    const session = this.graph.sql("SELECT s.*,a.user_id,a.revision AS current_revision FROM OutputSessions s JOIN OutputAccounts a ON a.collection_id=s.collection_id AND a.protocol=s.protocol WHERE s.token_hash=? AND s.protocol=?").get(hash(token), protocol);
    if (!session || session.expires_at <= this.graph.clock() || session.current_revision !== session.account_revision) throw error("Invalid output session");
    const collection = this.collection(session.collection_id);
    if (collection.revision !== session.collection_revision) throw error("Invalid output session");
    return { userId: session.user_id, collectionId: collection.id, name: collection.name, expiresAt: session.expires_at };
  }
  revoke(protocol, token) {
    validProtocol(protocol);
    if (typeof token !== "string" || token.length > 256) return false;
    return this.graph.sql("DELETE FROM OutputSessions WHERE protocol=? AND token_hash=?").run(protocol, hash(token)).changes > 0;
  }
}

module.exports = { OutputAuth };

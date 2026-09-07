"use strict";
const crypto = require("node:crypto");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message, status = 401) => Object.assign(new Error(message), { status });
const validToken = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

// Public bearer tokens are separate from canonical library IDs. Only hashes are
// usable without the owner's unlocked vault; management can recover the links.
class CustomerOutputLinks {
  constructor(graph) { this.graph = graph; }
  owner(collectionId) {
    const owner = this.graph.sql("SELECT c.id,c.revision,c.enabled FROM CustomerCollections o JOIN Customers c ON c.id=o.customer_id WHERE o.collection_id=?").get(collectionId);
    if (!owner?.enabled) throw fail("Customer library is unavailable", 404);
    this.graph.collectionAccess(collectionId, { includeSignal: false }).assertCurrent();
    return owner;
  }
  row(collectionId) {
    return this.graph.sql("SELECT * FROM CustomerOutputLinks WHERE collection_id=?").get(collectionId);
  }
  current(row) {
    if (!row) throw fail("Invalid installation credentials");
    const owner = this.owner(row.collection_id);
    if (owner.id !== row.customer_id || owner.revision !== row.customer_revision) throw fail("Installation credentials revoked");
    return owner;
  }
  credentials(collectionId) {
    const owner = this.owner(collectionId), row = this.row(collectionId);
    if (!row) return this.rotate(collectionId);
    this.current(row);
    const result = this.graph.customerOpen(owner.id, "output-links", collectionId, row.encrypted_credentials);
    if (!validToken(result?.token) || !validToken(result?.password) || hash(result.token) !== row.token_hash || hash(result.password) !== row.password_hash) throw fail("Invalid installation credentials");
    return { token: result.token, username: result.token, password: result.password };
  }
  rotate(collectionId) {
    const owner = this.owner(collectionId);
    const token = crypto.randomBytes(32).toString("hex"), password = crypto.randomBytes(32).toString("hex");
    const encrypted = this.graph.customerSeal(owner.id, "output-links", collectionId, { token, password });
    this.graph.sql(`INSERT INTO CustomerOutputLinks(collection_id,customer_id,customer_revision,token_hash,password_hash,encrypted_credentials,created_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(collection_id) DO UPDATE SET customer_id=excluded.customer_id,customer_revision=excluded.customer_revision,
      token_hash=excluded.token_hash,password_hash=excluded.password_hash,encrypted_credentials=excluded.encrypted_credentials,created_at=excluded.created_at`)
      .run(collectionId, owner.id, owner.revision, hash(token), hash(password), encrypted, this.graph.clock());
    return { token, username: token, password };
  }
  resolve(token) {
    if (!validToken(token)) throw fail("Invalid installation credentials");
    const row = this.graph.sql("SELECT * FROM CustomerOutputLinks WHERE token_hash=?").get(hash(token));
    this.current(row);
    return row.collection_id;
  }
  authenticate(username, password) {
    if (!validToken(username) || !validToken(password)) throw fail("Invalid installation credentials");
    const row = this.graph.sql("SELECT * FROM CustomerOutputLinks WHERE token_hash=?").get(hash(username));
    if (!crypto.timingSafeEqual(Buffer.from(hash(password), "hex"), Buffer.from(row?.password_hash || "0".repeat(64), "hex")) || !row) throw fail("Invalid installation credentials");
    this.current(row);
    return row.collection_id;
  }
  revoke(collectionId) {
    this.owner(collectionId);
    return this.graph.sql("DELETE FROM CustomerOutputLinks WHERE collection_id=?").run(collectionId).changes > 0;
  }
}
module.exports = { CustomerOutputLinks };

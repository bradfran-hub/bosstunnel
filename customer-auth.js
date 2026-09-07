"use strict";
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { WorkLimiter } = require("./limiter");
const { PasswordVaults } = require("./password-vault");
const derive = promisify(crypto.scrypt);
const OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length > 1024 || b.length > 1024) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const DUMMY = `scrypt$131072$8$1$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;
function username(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(value)) throw fail("Username must be 3-32 letters, numbers, dots, underscores or hyphens");
  return value.toLowerCase();
}
function password(value, creating = false) {
  const valid = typeof value === "string" && Buffer.byteLength(value) <= 512 && [...value].length >= 8 && [...value].length <= 128 && /[0-9]/.test(value) && /[^A-Za-z0-9\s]/.test(value);
  if (!valid) throw fail(creating ? "Use 8-128 characters with at least one number and one special character" : "Invalid username or password", creating ? 400 : 401);
  return value;
}
class CustomerAuth {
  constructor(graph, { ttlMs = 7 * 86400000, maxSessions = 16, maxCustomers = 10000, vaultTtlMs = 3600000 } = {}) {
    if (graph.customerVaults) throw fail("Customer vault service is already attached", 409);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 86400000 || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 100 || !Number.isSafeInteger(maxCustomers) || maxCustomers < 1) throw fail("Invalid account limits");
    this.graph = graph; this.ttlMs = ttlMs; this.maxSessions = maxSessions; this.maxCustomers = maxCustomers;
    this.limiter = new WorkLimiter({ concurrency: 1, maxQueued: 8, waitMs: 10000 });
    this.pending = new Set(); this.closed = false;
    this.vaults = new PasswordVaults({ clock: graph.clock, ttlMs: vaultTtlMs });
    this.vaultBindings = new Map();
    graph.customerVaults = this;
  }
  lockVault(customerId) { this.vaults.lock(customerId); this.vaultBindings.delete(customerId); }
  vaultRow(customerId) { return this.graph.sql("SELECT * FROM CustomerVaults WHERE customer_id=?").get(customerId); }
  bindVault(row, vault) {
    const binding = { accountRevision: row.revision, vaultRevision: vault.revision, wrapper: vault.wrapper };
    this.vaultBindings.set(row.id, binding);
    this.vaults.access(row.id).signal.addEventListener("abort", () => {
      if (this.vaultBindings.get(row.id) === binding) this.vaultBindings.delete(row.id);
    }, { once: true });
  }
  vaultAccess(customerId) {
    const current = this.graph.sql("SELECT enabled,revision FROM Customers WHERE id=?").get(customerId);
    const vault = this.vaultRow(customerId), binding = this.vaultBindings.get(customerId);
    if (!current?.enabled || !vault || !binding || current.revision !== binding.accountRevision || vault.revision !== binding.vaultRevision || vault.wrapper !== binding.wrapper) {
      this.lockVault(customerId); throw fail("Vault is locked; sign in with your password to unlock it", 423);
    }
    const access = this.vaults.access(customerId);
    return { signal: access.signal, assertCurrent: () => { access.assertCurrent(); this.vaultAccess(customerId); } };
  }
  vaultStatus(customerId) {
    try { this.vaultAccess(customerId); return this.vaults.status(customerId); }
    catch (error) { if (error.status !== 423) throw error; return { unlocked: false, expiresAt: null }; }
  }
  unlockedOwners() {
    return [...this.vaultBindings.keys()].filter(id => this.vaultStatus(id).unlocked);
  }
  assertUnchanged(row, vault) {
    const current = this.graph.sql("SELECT * FROM Customers WHERE id=?").get(row.id), next = this.vaultRow(row.id);
    if (!current?.enabled || current.revision !== row.revision || current.password_hash !== row.password_hash || !next || next.revision !== vault.revision || next.wrapper !== vault.wrapper) throw fail("Account changed; sign in again", 401);
    return current;
  }
  hmac(kind, value) { return crypto.createHmac("sha256", this.graph.secrets.key).update(JSON.stringify([kind, value])).digest("hex"); }
  lookup(name) { return this.hmac("customer-username", name); }
  async work(task) {
    if (this.closed) throw fail("Account service is shutting down", 503);
    const pending = this.limiter.run(task); this.pending.add(pending);
    try { return await pending; }
    catch (error) { if (error.status) throw error; throw fail("Account service is busy; retry shortly", 503); }
    finally { this.pending.delete(pending); }
  }
  attempt(peer, kind, name) {
    if (typeof peer !== "string" || !peer || peer.length > 128) throw fail("Invalid authentication context");
    const now = this.graph.clock();
    const buckets = [{ key: this.hmac("auth-peer", peer), limit: 20, window: 60000 },
      ...(kind === "signup" ? [{ key: this.hmac("auth-signup", peer), limit: 5, window: 3600000 }] : [{ key: this.hmac(`auth-${kind}`, name), limit: 10, window: 900000 }])];
    this.buckets(buckets, now);
  }
  management(customerId, mutation = false) {
    this.buckets([{ key: this.hmac("management", customerId), limit: 240, window: 60000 },
      ...(mutation ? [{ key: this.hmac("management-write", customerId), limit: 60, window: 60000 }] : [])]);
  }
  buckets(buckets, now = this.graph.clock()) {
    this.graph.db.transaction(() => {
      this.graph.sql("DELETE FROM CustomerAuthAttempts WHERE reset_at<=?").run(now);
      for (const bucket of buckets) {
        const row = this.graph.sql("SELECT * FROM CustomerAuthAttempts WHERE bucket=?").get(bucket.key);
        if (row?.hits >= bucket.limit) throw Object.assign(fail("Too many attempts; try again later", 429), { retryAfter: Math.max(1, Math.ceil((row.reset_at - now) / 1000)) });
        if (!row && this.graph.sql("SELECT count(*) n FROM CustomerAuthAttempts").get().n >= 10000) throw Object.assign(fail("Account service is busy; try again later", 429), { retryAfter: 60 });
      }
      for (const bucket of buckets) this.graph.sql("INSERT INTO CustomerAuthAttempts VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1").run(bucket.key, now + bucket.window);
    })();
  }
  async hash(value) {
    const salt = crypto.randomBytes(16), key = await derive(password(value, true), salt, 64, OPTIONS);
    try { return `scrypt$131072$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`; }
    finally { key.fill(0); }
  }
  async matches(value, encoded) {
    password(value);
    const match = String(encoded).match(/^scrypt\$131072\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/);
    if (!match) return false;
    const key = await derive(value, Buffer.from(match[1], "base64url"), 64, OPTIONS);
    try { return crypto.timingSafeEqual(key, Buffer.from(match[2], "base64url")); }
    finally { key.fill(0); }
  }
  public(row) {
    let profile = null;
    try { profile = this.graph.customerOpen(row.id, "customer-profile", row.id, row.encrypted_profile); }
    catch (error) { if (error.status !== 423) throw error; }
    return { id: row.id, username: profile?.username || null, createdAt: row.created_at };
  }
  recovery() { return `boss-recovery-${crypto.randomBytes(32).toString("base64url")}`; }
  session(row) {
    const now = this.graph.clock(), token = crypto.randomBytes(32).toString("base64url"), expiresAt = now + this.ttlMs;
    this.graph.sql("DELETE FROM CustomerSessions WHERE expires_at<=?").run(now);
    this.graph.sql("DELETE FROM CustomerSessions WHERE token_hash IN (SELECT token_hash FROM CustomerSessions WHERE customer_id=? ORDER BY created_at DESC,token_hash LIMIT -1 OFFSET ?)").run(row.id, this.maxSessions - 1);
    this.graph.sql("INSERT INTO CustomerSessions VALUES(?,?,?,?,?)").run(digest(token), row.id, row.revision, now, expiresAt);
    return { token, csrfToken: this.hmac("customer-csrf", token), expiresAt, customer: this.public(row), vault: this.vaultStatus(row.id) };
  }
  register(input, peer) {
    return this.work(async () => {
      const name = username(input?.username); password(input?.password, true); this.attempt(peer, "signup", name);
      const encoded = await this.hash(input.password), code = this.recovery(), now = this.graph.clock();
      const id = crypto.randomBytes(16).toString("hex");
      const wrapper = await this.vaults.create(id, input.password);
      const encryptedProfile = `boss-vault:1:${this.vaults.seal(id, "customer-profile", id, { username: name })}`;
      try {
        return this.graph.db.transaction(() => {
          const lookup = this.lookup(name);
          if (this.graph.sql("SELECT 1 FROM Customers WHERE username IN (?,?)").get(lookup, name)) throw fail("Username is unavailable", 409);
          if (this.graph.sql("SELECT count(*) n FROM Customers").get().n >= this.maxCustomers) throw fail("Registration capacity has been reached", 503);
          this.graph.sql("INSERT INTO Customers(id,username,encrypted_profile,password_hash,recovery_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, lookup, encryptedProfile, encoded, this.hmac("customer-recovery", code), now, now);
          this.graph.sql("INSERT INTO CustomerVaults(customer_id,wrapper,created_at,updated_at) VALUES(?,?,?,?)").run(id, JSON.stringify(wrapper), now, now);
          const row = this.graph.sql("SELECT * FROM Customers WHERE id=?").get(id);
          this.bindVault(row, this.vaultRow(id));
          return { ...this.session(row), recoveryCode: code };
        })();
      } catch (error) { this.lockVault(id); throw error; }
    });
  }
  login(input, peer) {
    return this.work(async () => {
      let name;
      try { name = username(input?.username); } catch { throw fail("Invalid username or password", 401); }
      password(input?.password); this.attempt(peer, "login", name);
      const row = this.graph.sql("SELECT * FROM Customers WHERE username IN (?,?) ORDER BY username=? DESC LIMIT 1").get(this.lookup(name), name, this.lookup(name));
      const matched = await this.matches(input.password, row?.password_hash || DUMMY);
      if (!matched || !row?.enabled) throw fail("Invalid username or password", 401);
      const vault = this.vaultRow(row.id);
      if (!vault) throw fail("This account requires an explicit password-vault migration", 409);
      try {
        this.assertUnchanged(row, vault);
        await this.vaults.unlock(row.id, input.password, JSON.parse(vault.wrapper));
        return this.graph.db.transaction(() => {
          const current = this.assertUnchanged(row, vault);
          this.bindVault(current, vault);
          this.graph.sql("DELETE FROM CustomerAuthAttempts WHERE bucket=?").run(this.hmac("auth-login", name));
          return this.session(current);
        })();
      } catch (error) { this.lockVault(row.id); throw error; }
    });
  }
  verify(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail("Sign in to continue", 401);
    const row = this.graph.sql("SELECT c.*,s.expires_at FROM CustomerSessions s JOIN Customers c ON c.id=s.customer_id WHERE s.token_hash=? AND c.enabled=1 AND s.customer_revision=c.revision AND s.expires_at>?").get(digest(token), this.graph.clock());
    if (!row) throw fail("Session expired; sign in again", 401);
    return { customer: this.public(row), expiresAt: row.expires_at, csrfToken: this.hmac("customer-csrf", token), vault: this.vaultStatus(row.id) };
  }
  csrf(token, provided) { const session = this.verify(token); if (!safeEqual(session.csrfToken, provided)) throw fail("Invalid session request", 403); return session; }
  revoke(token, { lock = true } = {}) {
    if (typeof token !== "string") return;
    const row = this.graph.sql("SELECT customer_id FROM CustomerSessions WHERE token_hash=?").get(digest(token));
    this.graph.sql("DELETE FROM CustomerSessions WHERE token_hash=?").run(digest(token));
    if (row && lock) this.lockVault(row.customer_id);
  }
  revokeAll(token) { const { customer } = this.verify(token); this.graph.sql("DELETE FROM CustomerSessions WHERE customer_id=?").run(customer.id); this.lockVault(customer.id); }
  changePassword(token, input, peer) {
    return this.work(async () => {
      const { customer } = this.verify(token); password(input?.password, true);
      const row = this.graph.sql("SELECT * FROM Customers WHERE id=?").get(customer.id);
      this.attempt(peer, "password", row.username);
      if (!await this.matches(input.currentPassword, row.password_hash)) throw fail("Current password is incorrect", 401);
      const vault = this.vaultRow(row.id);
      if (!vault) throw fail("This account requires an explicit password-vault migration", 409);
      const encoded = await this.hash(input.password), code = this.recovery();
      const wrapper = await this.vaults.rewrap(row.id, input.currentPassword, input.password, JSON.parse(vault.wrapper));
      const result = this.graph.db.transaction(() => {
        this.verify(token);
        this.assertUnchanged(row, vault);
        this.graph.sql("UPDATE Customers SET password_hash=?,recovery_hash=?,revision=revision+1,updated_at=? WHERE id=?").run(encoded, this.hmac("customer-recovery", code), this.graph.clock(), row.id);
        this.graph.sql("UPDATE CustomerVaults SET wrapper=?,revision=revision+1,updated_at=? WHERE customer_id=?").run(JSON.stringify(wrapper), this.graph.clock(), row.id);
        this.graph.sql("DELETE FROM CustomerSessions WHERE customer_id=?").run(row.id);
        this.graph.sql("DELETE FROM OutputSessions WHERE collection_id IN (SELECT collection_id FROM CustomerCollections WHERE customer_id=?)").run(row.id);
        this.lockVault(row.id);
        return { ...this.session(this.graph.sql("SELECT * FROM Customers WHERE id=?").get(row.id)), recoveryCode: code };
      })();
      // Password rotation leaves the vault locked. A fresh password login is
      // explicit and cannot resurrect an in-flight operation from the old key.
      return result;
    });
  }
  recover(input, peer) {
    return this.work(async () => {
      const name = username(input?.username); password(input?.password, true); this.attempt(peer, "recovery", name);
      const row = this.graph.sql("SELECT * FROM Customers WHERE username IN (?,?) ORDER BY username=? DESC LIMIT 1").get(this.lookup(name), name, this.lookup(name));
      const code = typeof input.recoveryCode === "string" && input.recoveryCode.length <= 128 ? input.recoveryCode : "";
      if (!safeEqual(row?.recovery_hash || "0".repeat(64), this.hmac("customer-recovery", code)) || !row?.enabled) throw fail("Invalid username or recovery code", 401);
      const encoded = await this.hash(input.password), nextCode = this.recovery(), now = this.graph.clock();
      const sourceIds = this.graph.sql("SELECT source_id FROM CustomerSources WHERE customer_id=? ORDER BY source_id").all(row.id).map(item => item.source_id);
      const collectionIds = this.graph.sql("SELECT collection_id FROM CustomerCollections WHERE customer_id=? ORDER BY collection_id").all(row.id).map(item => item.collection_id);
      this.lockVault(row.id);
      const wrapper = await this.vaults.create(row.id, input.password);
      const encryptedProfile = `boss-vault:1:${this.vaults.seal(row.id, "customer-profile", row.id, { username: name })}`;
      try {
        return this.graph.db.transaction(() => {
          const current = this.graph.sql("SELECT * FROM Customers WHERE id=?").get(row.id);
          if (!current?.enabled || current.revision !== row.revision || !safeEqual(current.recovery_hash, row.recovery_hash)) throw fail("Account changed; start recovery again", 409);
          for (const id of collectionIds) this.graph.sql("DELETE FROM Collections WHERE id=?").run(id);
          for (const id of sourceIds) this.graph.sql("DELETE FROM Sources WHERE id=?").run(id);
          this.graph.sql("UPDATE Customers SET username=?,encrypted_profile=?,password_hash=?,recovery_hash=?,revision=revision+1,updated_at=? WHERE id=?").run(this.lookup(name), encryptedProfile, encoded, this.hmac("customer-recovery", nextCode), now, row.id);
          this.graph.sql("UPDATE CustomerVaults SET wrapper=?,revision=revision+1,updated_at=? WHERE customer_id=?").run(JSON.stringify(wrapper), now, row.id);
          this.graph.sql("DELETE FROM CustomerSessions WHERE customer_id=?").run(row.id);
          const updated = this.graph.sql("SELECT * FROM Customers WHERE id=?").get(row.id), vault = this.vaultRow(row.id);
          this.bindVault(updated, vault);
          return { ...this.session(updated), recoveryCode: nextCode, removedSourceIds: sourceIds };
        })();
      } catch (error) { this.lockVault(row.id); throw error; }
    });
  }
  deleteAccount(token, input, peer) {
    return this.work(async () => {
      const { customer } = this.verify(token);
      if (input?.confirmation !== "DELETE") throw fail("Type DELETE to confirm account deletion");
      password(input?.password);
      const row = this.graph.sql("SELECT * FROM Customers WHERE id=?").get(customer.id);
      this.attempt(peer, "delete", row.username);
      if (!await this.matches(input.password, row.password_hash)) throw fail("Current password is incorrect", 401);
      const sourceIds = this.graph.sql("SELECT source_id FROM CustomerSources WHERE customer_id=? ORDER BY source_id").all(row.id).map(item => item.source_id);
      const collectionIds = this.graph.sql("SELECT collection_id FROM CustomerCollections WHERE customer_id=? ORDER BY collection_id").all(row.id).map(item => item.collection_id);
      this.lockVault(row.id);
      this.graph.db.transaction(() => {
        for (const id of collectionIds) this.graph.sql("DELETE FROM Collections WHERE id=?").run(id);
        for (const id of sourceIds) this.graph.sql("DELETE FROM Sources WHERE id=?").run(id);
        this.graph.sql("DELETE FROM Customers WHERE id=?").run(row.id);
      })();
      return { ok: true, sourceIds };
    });
  }
  async close() {
    this.closed = true; this.limiter.close();
    await this.vaults.close();
    await Promise.allSettled([...this.pending]); this.vaultBindings.clear();
    if (this.graph.customerVaults === this) this.graph.customerVaults = null;
  }
}
module.exports = { CustomerAuth, username, password };

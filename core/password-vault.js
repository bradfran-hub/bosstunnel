"use strict";
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { WorkLimiter } = require("./limiter");
const scrypt = promisify(crypto.scrypt);
const KDF = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 });
const MAX_BYTES = 8 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const invalid = () => fail("Vault data is invalid or cannot be decrypted", 403);
function ownerId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw fail("Invalid vault owner");
  return value;
}
function passwordBytes(value, enforcePolicy = false) {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > 512 || [...value].length > 128) throw enforcePolicy ? fail("Use 8-128 characters with at least one number and one special character") : invalid();
  if (enforcePolicy && ([...value].length < 8 || !/[0-9]/.test(value) || !/[^A-Za-z0-9\s]/.test(value))) throw fail("Use 8-128 characters with at least one number and one special character");
  return Buffer.from(value, "utf8");
}
function decode(value, size, maximum = size) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum * 4 / 3) + 2 || !/^[A-Za-z0-9_-]*$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || bytes.length > maximum || size != null && bytes.length !== size) throw invalid();
  return bytes;
}
function aad(owner, purpose, id) {
  ownerId(owner);
  if (typeof purpose !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(purpose) || typeof id !== "string" || !id || Buffer.byteLength(id) > 512) throw fail("Invalid vault record context");
  return Buffer.from(JSON.stringify(["boss-password-vault", 1, owner, purpose, id]));
}
function encrypt(key, bytes, context) {
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(context);
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") };
}
function decrypt(key, envelope, context, size, maximum = size) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw invalid();
  let first;
  try {
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, decode(envelope.nonce, 12));
    cipher.setAAD(context); cipher.setAuthTag(decode(envelope.tag, 16));
    first = cipher.update(decode(envelope.data, size, maximum));
    const final = cipher.final();
    try { return Buffer.concat([first, final]); } finally { final.fill(0); }
  } catch { throw invalid(); }
  finally { first?.fill(0); }
}
function wrappedContext(owner, salt) { return aad(owner, "wrapped-key", `scrypt-131072-8-1:${salt}`); }
function validateEnvelope(envelope) {
  if (!envelope || envelope.version !== 1 || envelope.kdf !== "scrypt-131072-8-1" || envelope.cipher !== "aes-256-gcm") throw invalid();
  return decode(envelope.salt, 16);
}

// No server master key or recovery key is accepted by this class. Only wrapped
// keys are persisted by its caller; unlocked data keys live in this process.
class PasswordVaults {
  #keys = new Map();
  #pending = new Set();
  #closed = false;
  constructor({ clock = Date.now, ttlMs = 3600000, maxUnlocked = 1024 } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 86400000 || !Number.isSafeInteger(maxUnlocked) || maxUnlocked < 1 || maxUnlocked > 10000) throw fail("Invalid vault limits");
    this.clock = clock; this.ttlMs = ttlMs; this.maxUnlocked = maxUnlocked;
    this.limiter = new WorkLimiter({ concurrency: 1, maxQueued: 8, waitMs: 10000 });
    this.timer = setInterval(() => this.sweep(), Math.min(ttlMs, 30000));
    this.timer.unref();
  }
  sweep() {
    const now = this.clock();
    for (const [owner, entry] of this.#keys) if (entry.expiresAt <= now) this.lock(owner);
  }
  lock(owner) {
    ownerId(owner);
    for (const job of this.#pending) if (job.owner === owner) job.cancelled = true;
    const entry = this.#keys.get(owner);
    entry?.controller.abort(fail("Vault was locked", 423));
    entry?.key.fill(0); this.#keys.delete(owner);
  }
  status(owner) {
    ownerId(owner); this.sweep();
    const entry = this.#keys.get(owner);
    return { unlocked: Boolean(entry), expiresAt: entry?.expiresAt || null };
  }
  #key(owner) {
    ownerId(owner); this.sweep();
    const entry = this.#keys.get(owner);
    if (this.#closed || !entry) throw fail("Vault is locked; sign in with your password to unlock it", 423);
    return entry.key;
  }
  access(owner) {
    this.#key(owner);
    const entry = this.#keys.get(owner);
    return { signal: entry.controller.signal, assertCurrent: () => {
      this.#key(owner);
      if (this.#keys.get(owner) !== entry) throw fail("Vault access was replaced; retry after unlocking", 423);
    } };
  }
  #install(owner, key, check) {
    this.sweep();
    check();
    if (!this.#keys.has(owner) && this.#keys.size >= this.maxUnlocked) throw fail("Unlocked vault capacity reached", 503);
    this.#keys.get(owner)?.controller.abort(fail("Vault access was replaced", 423));
    this.#keys.get(owner)?.key.fill(0);
    this.#keys.set(owner, { key: Buffer.from(key), controller: new AbortController(), expiresAt: this.clock() + this.ttlMs });
  }
  async #work(owner, task) {
    ownerId(owner);
    if (this.#closed) throw fail("Vault service is closed", 503);
    if (this.#pending.size >= 9) throw fail("Vault service is busy; retry shortly", 503);
    const job = { owner, cancelled: false };
    this.#pending.add(job);
    const check = () => { if (job.cancelled || this.#closed) throw fail("Vault unlock was cancelled", 423); };
    job.promise = this.limiter.run(async () => { check(); return task(check); });
    try { return await job.promise; }
    catch (error) { if (error.status) throw error; throw fail("Vault service is busy; retry shortly", 503); }
    finally { this.#pending.delete(job); }
  }
  async #wrap(owner, password, key) {
    const salt = crypto.randomBytes(16), bytes = passwordBytes(password, true);
    let wrapping;
    try {
      wrapping = await scrypt(bytes, salt, 32, KDF);
      const encodedSalt = salt.toString("base64url");
      return { version: 1, kdf: "scrypt-131072-8-1", cipher: "aes-256-gcm", salt: encodedSalt,
        ...encrypt(wrapping, key, wrappedContext(owner, encodedSalt)) };
    } finally { bytes.fill(0); wrapping?.fill(0); }
  }
  async #unwrap(owner, password, envelope) {
    const salt = validateEnvelope(envelope), bytes = passwordBytes(password);
    let wrapping;
    try {
      wrapping = await scrypt(bytes, salt, 32, KDF);
      return decrypt(wrapping, envelope, wrappedContext(owner, envelope.salt), 32);
    } finally { bytes.fill(0); wrapping?.fill(0); }
  }
  create(owner, password) {
    return this.#work(owner, async check => {
      if (this.#keys.has(owner)) throw fail("Vault is already unlocked", 409);
      const key = crypto.randomBytes(32);
      try {
        const envelope = await this.#wrap(owner, password, key);
        this.#install(owner, key, check);
        return envelope;
      } finally { key.fill(0); }
    });
  }
  unlock(owner, password, envelope) {
    return this.#work(owner, async check => {
      const key = await this.#unwrap(owner, password, envelope);
      try { this.#install(owner, key, check); return this.status(owner); }
      finally { key.fill(0); }
    });
  }
  rewrap(owner, currentPassword, nextPassword, envelope) {
    return this.#work(owner, async check => {
      const key = await this.#unwrap(owner, currentPassword, envelope);
      try {
        check();
        const next = await this.#wrap(owner, nextPassword, key);
        check();
        // Caller must atomically commit the wrapper and account/session revision
        // before explicitly unlocking again; rewrap never activates a new key.
        return next;
      } finally { key.fill(0); }
    });
  }
  seal(owner, purpose, id, value) {
    const key = this.#key(owner), context = aad(owner, purpose, id);
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_BYTES) throw fail("Vault record exceeds 8 MiB", 413);
    const bytes = Buffer.from(serialized);
    try { return JSON.stringify({ version: 1, ...encrypt(key, bytes, context) }); }
    finally { bytes.fill(0); }
  }
  open(owner, purpose, id, value) {
    const key = this.#key(owner), context = aad(owner, purpose, id);
    if (typeof value !== "string" || value.length > Math.ceil(MAX_BYTES * 4 / 3) + 512) throw invalid();
    let bytes;
    try {
      const envelope = JSON.parse(value);
      if (envelope?.version !== 1) throw invalid();
      bytes = decrypt(key, envelope, context, null, MAX_BYTES);
      return JSON.parse(bytes.toString("utf8"));
    } catch { throw invalid(); }
    finally { bytes?.fill(0); }
  }
  async close() {
    this.#closed = true; clearInterval(this.timer);
    for (const job of this.#pending) job.cancelled = true;
    this.limiter.close();
    for (const owner of this.#keys.keys()) this.lock(owner);
    await Promise.allSettled([...this.#pending].map(job => job.promise));
  }
}
module.exports = { PasswordVaults };

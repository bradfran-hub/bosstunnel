"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { PasswordVaults } = require("../core/password-vault");
const { Secrets } = require("../core/secrets");
const password = "long vault fixture password 1!";
const nextPassword = "new unrelated vault 1!";

test("password alone unlocks persisted customer secrets after process state is discarded", async () => {
  const directory = await fs.mkdtemp("/tmp/boss-password-vault-");
  let vaults = new PasswordVaults();
  try {
    const wrapper = await vaults.create("customer-one", password);
    const payload = { username: "private-provider-user", password: "private-provider-secret", url: "https://owned.example/private" };
    const ciphertext = vaults.seal("customer-one", "source-config", "source-one", payload);
    const stored = JSON.stringify({ wrapper, ciphertext });
    for (const secret of [password, ...Object.values(payload)]) assert.ok(!stored.includes(secret));
    await fs.writeFile(`${directory}/fixture`, stored, { mode: 0o600 });
    await vaults.close(); vaults = new PasswordVaults();
    const disk = JSON.parse(await fs.readFile(`${directory}/fixture`, "utf8"));
    assert.throws(() => vaults.open("customer-one", "source-config", "source-one", disk.ciphertext), { status: 423 });
    const admin = new Secrets("independent-server-secret-at-least-32-characters");
    assert.throws(() => admin.open(ciphertext));
    await assert.rejects(vaults.unlock("customer-one", nextPassword, disk.wrapper), { status: 403 });
    assert.equal(vaults.status("customer-one").unlocked, false);
    await vaults.unlock("customer-one", password, disk.wrapper);
    assert.deepEqual(vaults.open("customer-one", "source-config", "source-one", disk.ciphertext), payload);
  } finally { await vaults.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("vault encryption binds owner, record purpose and identity and rejects tampering", async () => {
  const vaults = new PasswordVaults();
  try {
    const first = await vaults.create("one", password), second = await vaults.create("two", password);
    assert.notEqual(first.salt, second.salt); assert.notEqual(first.data, second.data);
    await assert.rejects(vaults.unlock("two", password, first), { status: 403 });
    const ciphertext = vaults.seal("one", "source-config", "first", { token: "secret" });
    assert.notEqual(ciphertext, vaults.seal("one", "source-config", "first", { token: "secret" }));
    for (const args of [["two", "source-config", "first"], ["one", "resolution-cache", "first"], ["one", "source-config", "second"]]) {
      assert.throws(() => vaults.open(...args, ciphertext), { status: 403 });
    }
    for (const field of ["nonce", "tag", "data"]) {
      const corrupt = JSON.parse(ciphertext);
      corrupt[field] = (corrupt[field][0] === "A" ? "B" : "A") + corrupt[field].slice(1);
      assert.throws(() => vaults.open("one", "source-config", "first", JSON.stringify(corrupt)), { status: 403 });
    }
    for (const wrapper of [{ ...first, kdf: "scrypt-1-1-1" }, { ...first, version: 2 }, { ...first, salt: first.salt + "=" }]) {
      await assert.rejects(vaults.unlock("one", password, wrapper), { status: 403 });
    }
  } finally { await vaults.close(); }
});

test("password changes preserve encrypted records but require the new password with the new wrapper", async () => {
  let vaults = new PasswordVaults();
  try {
    const wrapper = await vaults.create("one", password);
    const ciphertext = vaults.seal("one", "source-config", "source", { credential: "owned" });
    await assert.rejects(vaults.rewrap("one", nextPassword, password, wrapper), { status: 403 });
    const changed = await vaults.rewrap("one", password, nextPassword, wrapper);
    assert.notEqual(changed.salt, wrapper.salt);
    await vaults.close(); vaults = new PasswordVaults();
    await assert.rejects(vaults.unlock("one", password, changed), { status: 403 });
    await vaults.unlock("one", nextPassword, changed);
    assert.deepEqual(vaults.open("one", "source-config", "source", ciphertext), { credential: "owned" });
  } finally { await vaults.close(); }
});

test("fixed unlock expiry and bounded capacity do not evict or silently reopen vaults", async () => {
  let now = 1000;
  const vaults = new PasswordVaults({ clock: () => now, ttlMs: 1000, maxUnlocked: 1 });
  try {
    const wrapper = await vaults.create("one", password);
    const ciphertext = vaults.seal("one", "source-config", "source", {});
    now = 1999; vaults.open("one", "source-config", "source", ciphertext);
    assert.equal(vaults.status("one").expiresAt, 2000, "media access cannot extend unlock lifetime");
    await assert.rejects(vaults.create("two", password), { status: 503 });
    assert.equal(vaults.status("one").unlocked, true);
    now = 2000;
    assert.throws(() => vaults.open("one", "source-config", "source", ciphertext), { status: 423 });
    await vaults.unlock("one", password, wrapper);
    assert.equal(vaults.status("one").expiresAt, 3000);
    vaults.lock("one");
    assert.throws(() => vaults.seal("one", "source-config", "source", {}), { status: 423 });
  } finally { await vaults.close(); }
});

test("lock and shutdown cancel pending password derivations without key resurrection", async () => {
  const vaults = new PasswordVaults();
  const first = vaults.create("one", password);
  vaults.lock("one");
  await assert.rejects(first, { status: 423 });
  assert.equal(vaults.status("one").unlocked, false);
  const second = vaults.create("one", password);
  // Let the KDF enter its asynchronous worker before locking.
  await new Promise(resolve => setImmediate(resolve));
  vaults.lock("one");
  await assert.rejects(second, { status: 423 });
  const pending = vaults.create("one", password);
  const rejected = assert.rejects(pending, { status: 423 });
  await vaults.close(); await rejected;
  assert.equal(vaults.status("one").unlocked, false);
  await assert.rejects(vaults.create("one", password), { status: 503 });
});

test("malformed, oversized and server-encrypted inputs fail closed", async () => {
  const vaults = new PasswordVaults();
  try {
    await assert.rejects(vaults.create("one", "short"), { status: 400 });
    await vaults.create("one", password);
    for (const value of [null, "{}", "[]", "null", "not encoded", "x".repeat(12 * 1024 * 1024), new Secrets("independent-server-secret-at-least-32-characters").seal({ token: "secret" })]) {
      assert.throws(() => vaults.open("one", "source-config", "source", value), { status: 403 });
    }
    assert.throws(() => vaults.seal("one", "source-config", "source", "x".repeat(8 * 1024 * 1024)), { status: 413 });
    assert.throws(() => vaults.open("one", "source-config", "", "{}"), { status: 400 });
  } finally { await vaults.close(); }
});

test("unlock-scoped work is aborted on lock, replacement, expiry and shutdown", async () => {
  let now = 1000;
  const vaults = new PasswordVaults({ clock: () => now, ttlMs: 1000 });
  try {
    const wrapper = await vaults.create("one", password);
    const first = vaults.access("one");
    first.assertCurrent(); assert.equal(first.signal.aborted, false);
    vaults.lock("one"); assert.equal(first.signal.aborted, true);
    await vaults.unlock("one", password, wrapper);
    assert.throws(first.assertCurrent, { status: 423 });
    const second = vaults.access("one");
    await vaults.unlock("one", password, wrapper);
    assert.equal(second.signal.aborted, true);
    assert.throws(second.assertCurrent, { status: 423 });
    const third = vaults.access("one");
    now = 2000; vaults.sweep();
    assert.equal(third.signal.aborted, true);
    await vaults.unlock("one", password, wrapper);
    const fourth = vaults.access("one");
    await vaults.close();
    assert.equal(fourth.signal.aborted, true);
  } finally { await vaults.close(); }
});

test("queue overflow is bounded and queued unlocks cannot outlive account locking", async () => {
  const vaults = new PasswordVaults();
  try {
    const jobs = Array.from({ length: 9 }, (_, index) => {
      const job = vaults.create(`owner-${index}`, password);
      const assertion = assert.rejects(job, { status: 423 });
      vaults.lock(`owner-${index}`);
      return assertion;
    });
    await assert.rejects(vaults.create("overflow", password), { status: 503 });
    await Promise.all(jobs);
    assert.equal(vaults.status("owner-0").unlocked, false);
    assert.equal(vaults.status("owner-8").unlocked, false);
  } finally { await vaults.close(); }
});

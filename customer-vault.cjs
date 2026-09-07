"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MediaGraph } = require("../core/graph");
const { CustomerAuth } = require("../core/customer-auth");
const { PasswordVaults } = require("../core/password-vault");
const secret = "server secret is not a customer vault password";
const password = "customer password 1!";
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-auth-vault-"));
  const file = path.join(dir, "graph.db"), graph = new MediaGraph(file, { secret });
  const auth = new CustomerAuth(graph);
  return { dir, file, graph, auth, async close() { await auth.close(); graph.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
test("account key wrappers persist, but cookies, server keys and password verifiers cannot unlock them", async () => {
  const fixture = setup(), { graph, auth, file } = fixture;
  let restarted, reopened;
  const attacker = new PasswordVaults();
  try {
    const result = await auth.register({ username: "vault-user", password }, "fixture");
    const id = result.customer.id, record = auth.vaults.seal(id, "source", "one", { password: "private upstream credential" });
    const wrapper = auth.vaultRow(id), customer = graph.sql("SELECT * FROM Customers WHERE id=?").get(id);
    assert.equal(result.vault.unlocked, true); assert.equal(wrapper.revision, 1);
    assert.ok(!wrapper.wrapper.includes(password));
    for (const candidate of [secret, customer.password_hash, result.token, result.recoveryCode]) {
      await assert.rejects(attacker.unlock(id, candidate, JSON.parse(wrapper.wrapper)), error => error.status === 403);
    }
    const access = auth.vaultAccess(id);
    await auth.close(); assert.equal(access.signal.aborted, true);
    reopened = new MediaGraph(file, { secret }); restarted = new CustomerAuth(reopened);
    assert.equal(restarted.verify(result.token).vault.unlocked, false);
    assert.throws(() => restarted.vaultAccess(id), { status: 423 });
    const login = await restarted.login({ username: "vault-user", password }, "restart-fixture");
    assert.equal(login.vault.unlocked, true);
    assert.deepEqual(restarted.vaults.open(id, "source", "one", record), { password: "private upstream credential" });
    restarted.revoke(login.token);
    assert.equal(restarted.verify(result.token).vault.unlocked, false, "Another valid cookie must not unlock after logout");
  } finally { await attacker.close(); if (restarted) await restarted.close(); reopened?.close(); await fixture.close(); }
});

test("password rotation preserves data while destructive recovery replaces the vault and owned data", async () => {
  const fixture = setup(), { auth, graph } = fixture;
  try {
    const result = await auth.register({ username: "rotate-user", password }, "fixture"), id = result.customer.id;
    const original = auth.vaultRow(id), access = auth.vaultAccess(id);
    const record = auth.vaults.seal(id, "source", "one", { token: "owned upstream" });
    graph.addSource({ id: "source", protocol: "fixture", name: "Source", configuration: {}, customerId: id });
    const library = graph.createCollection({ name: "Library", sourceIds: ["source"], customerId: id });
    const { OutputAuth } = require("../core/output-auth"), output = new OutputAuth(graph);
    const credentials = output.provision(library.id, "jellyfin");
    const outputSession = output.authenticate("jellyfin", credentials.username, credentials.password, { deviceId: "test" });
    const changed = await auth.changePassword(result.token, { currentPassword: password, password: `${password} next` }, "fixture");
    assert.equal(changed.vault.unlocked, false); assert.equal(access.signal.aborted, true);
    assert.throws(() => access.assertCurrent(), { status: 423 });
    assert.throws(() => auth.verify(result.token), { status: 401 });
    assert.throws(() => output.verify("jellyfin", outputSession.token), { status: 401 });
    assert.equal(auth.vaultRow(id).revision, 2); assert.notEqual(auth.vaultRow(id).wrapper, original.wrapper);
    await assert.rejects(auth.login({ username: "rotate-user", password }, "fixture"), { status: 401 });
    await auth.login({ username: "rotate-user", password: `${password} next` }, "fixture");
    assert.deepEqual(auth.vaults.open(id, "source", "one", record), { token: "owned upstream" });
    const resetPassword = `${password} reset`;
    const reset = await auth.recover({ username: "rotate-user", password: resetPassword, recoveryCode: changed.recoveryCode }, "fixture");
    assert.equal(reset.vault.unlocked, true); assert.notEqual(reset.recoveryCode, changed.recoveryCode);
    assert.throws(() => auth.verify(changed.token), { status: 401 });
    await assert.rejects(auth.login({ username: "rotate-user", password: `${password} next` }, "fixture"), { status: 401 });
    assert.equal(graph.sql("SELECT count(*) n FROM CustomerSources WHERE customer_id=?").get(id).n, 0);
    assert.equal(graph.sql("SELECT count(*) n FROM CustomerCollections WHERE customer_id=?").get(id).n, 0);
    assert.equal(graph.sql("SELECT count(*) n FROM Sources WHERE id='source'").get().n, 0);
    assert.equal(graph.sql("SELECT count(*) n FROM Collections WHERE id=?").get(library.id).n, 0);
    assert.throws(() => auth.vaults.open(id, "source", "one", record));
    assert.equal((await auth.login({ username: "rotate-user", password: resetPassword }, "fixture")).customer.id, id);
  } finally { await fixture.close(); }
});

test("schema thirteen adds no administrator-decryptable wrapper to legacy accounts", async () => {
  const fixture = setup(), { graph, file } = fixture;
  let reopened, auth;
  try {
    graph.sql("INSERT INTO Customers(id,username,encrypted_profile,password_hash,recovery_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run("legacy", fixture.auth.lookup("legacy-user"), "legacy-profile", await fixture.auth.hash(password), "not-a-code", 1, 1);
    graph.addSource({ id: "legacy-source", protocol: "fixture", name: "Legacy", configuration: { password: "legacy upstream" } });
    const [mediaId] = graph.ingest("legacy-source", [{ type: "movie", title: "Legacy film", sourceKey: "movie" }]);
    const syntheticId = graph.synthetic("xtream", mediaId), canonical = graph.media(mediaId).canonicalId;
    graph.sql("INSERT INTO CustomerSources VALUES(?,?)").run("legacy-source", "legacy");
    graph.db.exec("DROP TABLE CustomerVaults; PRAGMA user_version=13");
    reopened = new MediaGraph(file, { secret }); auth = new CustomerAuth(reopened);
    assert.equal(reopened.db.pragma("user_version", { simple: true }), 16);
    assert.equal(reopened.sql("SELECT count(*) n FROM CustomerVaults").get().n, 0);
    assert.equal(reopened.fromSynthetic("xtream", syntheticId).canonicalId, canonical);
    await assert.rejects(auth.login({ username: "legacy-user", password }, "fixture"), error => error.status === 409 && /migration/.test(error.message));
    assert.equal(reopened.sql("SELECT count(*) n FROM CustomerSessions").get().n, 0);
    assert.throws(() => reopened.source("legacy-source", { credentials: true }), { status: 423 });
    assert.equal(reopened.secrets.open(reopened.sql("SELECT configuration FROM Sources WHERE id=?").get("legacy-source").configuration).password, "legacy upstream");
  } finally { if (auth) await auth.close(); reopened?.close(); await fixture.close(); }
});

test("registration failure rolls back the account, wrapper, session and unlocked key", async () => {
  const fixture = setup(), { graph, auth } = fixture;
  try {
    graph.db.exec("CREATE TRIGGER fail_session BEFORE INSERT ON CustomerSessions BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    let createdId;
    const create = auth.vaults.create.bind(auth.vaults);
    auth.vaults.create = async (...args) => { createdId = args[0]; return create(...args); };
    await assert.rejects(auth.register({ username: "rollback-user", password }, "fixture"));
    assert.ok(createdId);
    for (const table of ["Customers", "CustomerVaults", "CustomerSessions"]) assert.equal(graph.sql(`SELECT count(*) n FROM ${table}`).get().n, 0);
    assert.equal(auth.vaults.status(createdId).unlocked, false);
    assert.equal(auth.vaultBindings.size, 0);
  } finally { await fixture.close(); }
});

test("account and wrapper changes during password derivation cannot install stale access", async () => {
  const fixture = setup(), { graph, auth } = fixture;
  try {
    const result = await auth.register({ username: "race-user", password }, "fixture"), id = result.customer.id;
    auth.lockVault(id);
    const unlock = auth.vaults.unlock.bind(auth.vaults);
    auth.vaults.unlock = async (...args) => {
      const result = await unlock(...args);
      graph.sql("UPDATE CustomerVaults SET revision=revision+1 WHERE customer_id=?").run(id);
      return result;
    };
    await assert.rejects(auth.login({ username: "race-user", password }, "fixture"), { status: 401 });
    assert.equal(auth.vaults.status(id).unlocked, false);
    assert.equal(graph.sql("SELECT count(*) n FROM CustomerSessions").get().n, 1);
    auth.vaults.unlock = unlock;
    await auth.login({ username: "race-user", password }, "fixture");
    const access = auth.vaultAccess(id);
    graph.sql("UPDATE Customers SET enabled=0 WHERE id=?").run(id);
    assert.throws(() => access.assertCurrent(), { status: 423 }); assert.equal(access.signal.aborted, true);
    graph.sql("UPDATE Customers SET enabled=1 WHERE id=?").run(id);
    assert.throws(() => auth.vaultAccess(id), { status: 423 });
    await auth.login({ username: "race-user", password }, "fixture");
    const next = auth.vaultAccess(id);
    graph.sql("UPDATE Customers SET revision=revision+1 WHERE id=?").run(id);
    assert.throws(() => next.assertCurrent(), { status: 423 }); assert.equal(next.signal.aborted, true);
  } finally { await fixture.close(); }
});

test("password-change transaction failure retains the old wrapper and password", async () => {
  const fixture = setup(), { graph, auth } = fixture;
  try {
    const result = await auth.register({ username: "rollback-password", password }, "fixture"), id = result.customer.id;
    const before = auth.vaultRow(id);
    graph.db.exec("CREATE TRIGGER fail_wrapper BEFORE UPDATE ON CustomerVaults BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await assert.rejects(auth.changePassword(result.token, { currentPassword: password, password: `${password} next` }, "fixture"));
    assert.deepEqual(auth.vaultRow(id), before);
    assert.equal(auth.verify(result.token).customer.id, id);
    await auth.login({ username: "rollback-password", password }, "fixture");
  } finally { await fixture.close(); }
});

test("vault expiry and replacement invalidate old access without invalidating the web session", async () => {
  const fixture = setup();
  let now = 1000;
  const graph = new MediaGraph(path.join(fixture.dir, "expiry.db"), { secret, clock: () => now });
  const auth = new CustomerAuth(graph, { vaultTtlMs: 1000 });
  try {
    const result = await auth.register({ username: "expiry-user", password }, "fixture"), id = result.customer.id;
    const initial = auth.vaultAccess(id);
    now += 1000;
    assert.equal(auth.verify(result.token).vault.unlocked, false);
    assert.equal(initial.signal.aborted, true);
    assert.equal(auth.vaultBindings.size, 0);
    await auth.login({ username: "expiry-user", password }, "fixture");
    assert.throws(() => initial.assertCurrent(), { status: 423 });
    const next = auth.vaultAccess(id);
    await auth.login({ username: "expiry-user", password }, "fixture");
    assert.equal(next.signal.aborted, true); assert.throws(() => next.assertCurrent(), { status: 423 });
    auth.revokeAll(result.token);
    assert.throws(() => auth.vaultAccess(id), { status: 423 });
  } finally { await auth.close(); graph.close(); await fixture.close(); }
});

test("restored account wrappers stay locked and need the real password after server-key backup verification", async () => {
  const fixture = setup(), { graph, auth, file, dir } = fixture;
  let restored, restoredAuth;
  try {
    const result = await auth.register({ username: "restore-vault", password }, "fixture"), id = result.customer.id;
    const record = auth.vaults.seal(id, "source", "one", { token: "private" });
    const { snapshot, restore } = require("../backup.cjs");
    const backup = path.join(dir, "backup.sqlite"), target = path.join(dir, "restored.sqlite");
    assert.equal((await snapshot(file, backup, { secret })).schema, 16);
    assert.equal((await restore(backup, target, { secret })).revokedSessions, 1);
    restored = new MediaGraph(target, { secret }); restoredAuth = new CustomerAuth(restored);
    assert.deepEqual(restoredAuth.vaultRow(id), auth.vaultRow(id));
    assert.equal(restoredAuth.vaultStatus(id).unlocked, false);
    assert.throws(() => restoredAuth.verify(result.token), { status: 401 });
    await restoredAuth.login({ username: "restore-vault", password }, "fixture");
    assert.deepEqual(restoredAuth.vaults.open(id, "source", "one", record), { token: "private" });
    graph.db.exec("DROP TABLE CustomerVaults");
    await assert.rejects(snapshot(file, path.join(dir, "invalid.sqlite"), { secret }), /Not a Boss database/);
  } finally { if (restoredAuth) await restoredAuth.close(); restored?.close(); await fixture.close(); }
});

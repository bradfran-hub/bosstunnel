"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MediaGraph } = require("../core/graph");
const { CustomerAuth } = require("../core/customer-auth");
const { CatalogueRefresh } = require("../core/catalogue-refresh");
const crypto = require("node:crypto");
const password = "refresh fixture password 1!";
async function setup() {
  let now = 1000;
  const graph = new MediaGraph(":memory:", { secret: "refresh vault fixture server secret long enough", clock: () => now });
  const auth = new CustomerAuth(graph), account = await auth.register({ username: "refresh-owner", password }, "fixture");
  const calls = [], engine = { graph, sourceTasks: new Map(), async ingestSource(id) { calls.push(id); } };
  const scheduler = new CatalogueRefresh(engine, { intervalMs: 100, retryMs: 10 });
  return { graph, auth, account, engine, scheduler, calls, advance() { now += 100; },
    add(id, owned = true) { graph.addSource({ id, name: "Fixture", protocol: "fixture", configuration: {}, ...(owned ? { customerId: account.customer.id } : {}) }); },
    login: () => auth.login({ username: "refresh-owner", password }, "fixture"),
    async close() { scheduler.stop(); await scheduler.pending; await auth.close(); graph.close(); } };
}
test("locked due sources stay pending without starving an eligible source beyond the first page", async () => {
  const f = await setup();
  try {
    // Legacy accounts have no unlockable wrapper until explicit migration.
    // Four such owners keep this fixture within the 32-source account limit.
    for (let i = 0; i < 120; i++) {
      const id = `locked-${String(i).padStart(3, "0")}`;
      const owner = `legacy-${Math.floor(i / 30)}`;
      f.graph.sql("INSERT OR IGNORE INTO Customers(id,username,encrypted_profile,password_hash,recovery_hash,created_at,updated_at) VALUES(?,?,?,?,?,0,0)").run(owner, crypto.createHash("sha256").update(owner).digest("hex"), "legacy-profile", "fixture-no-login", "fixture-no-recovery");
      f.add(id, false); f.graph.sql("INSERT INTO CustomerSources VALUES(?,?)").run(id, owner);
    }
    f.add("z-admin", false);
    await f.scheduler.tick(); f.advance(); f.auth.lockVault(f.account.customer.id);
    await f.scheduler.tick(); assert.deepEqual(f.calls, ["z-admin"]);
    assert.equal(f.graph.sql("SELECT count(*) n FROM CatalogueRefresh WHERE source_id LIKE 'locked-%' AND status='pending' AND failures=0 AND last_started IS NULL").get().n, 120);
    await f.scheduler.tick(); assert.deepEqual(f.calls, ["z-admin"]);
  } finally { await f.close(); }
});
test("password unlock resumes due customer refreshes without changing their source identity", async () => {
  const f = await setup();
  try {
    f.add("owned"); await f.scheduler.tick(); f.advance();
    f.auth.lockVault(f.account.customer.id); await f.scheduler.tick(); assert.deepEqual(f.calls, []);
    await f.login(); await f.scheduler.tick(); assert.deepEqual(f.calls, ["owned"]);
    assert.equal(f.graph.sql("SELECT status FROM CatalogueRefresh WHERE source_id='owned'").get().status, "complete");
  } finally { await f.close(); }
});
test("locking during a scheduled refresh pauses it without recording a provider failure", async () => {
  const f = await setup();
  try {
    f.add("owned"); await f.scheduler.tick(); f.advance();
    const before = f.graph.sql("SELECT * FROM CatalogueRefresh WHERE source_id='owned'").get();
    f.engine.ingestSource = async () => { f.auth.lockVault(f.account.customer.id); throw Object.assign(new Error("Vault locked"), { status: 423 }); };
    await f.scheduler.tick();
    const paused = f.graph.sql("SELECT * FROM CatalogueRefresh WHERE source_id='owned'").get();
    assert.equal(paused.status, "pending"); assert.equal(paused.failures, 0); assert.equal(paused.next_at, before.next_at);
    await f.login(); f.engine.ingestSource = async () => {};
    await f.scheduler.tick(); assert.equal(f.graph.sql("SELECT status FROM CatalogueRefresh WHERE source_id='owned'").get().status, "complete");
  } finally { await f.close(); }
});
test("an upstream 423 remains a provider failure when the customer vault is still unlocked", async () => {
  const f = await setup();
  try {
    f.add("owned"); await f.scheduler.tick(); f.advance();
    f.engine.ingestSource = async () => { throw Object.assign(new Error("Upstream locked"), { status: 423 }); };
    await f.scheduler.tick();
    const row = f.graph.sql("SELECT * FROM CatalogueRefresh WHERE source_id='owned'").get();
    assert.equal(row.status, "failed"); assert.equal(row.failures, 1);
  } finally { await f.close(); }
});

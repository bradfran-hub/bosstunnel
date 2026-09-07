"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { MediaGraph } = require("../core/graph");
const { CustomerAuth } = require("../core/customer-auth");
const { CustomerOutputLinks } = require("../core/output-links");
const secret = "output links fixture server key long enough", password = "fixture customer password 1!";
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-links-")), file = path.join(dir, "graph.db");
  const f = { dir, file };
  f.open = () => { f.graph = new MediaGraph(file, { secret }); f.auth = new CustomerAuth(f.graph); f.links = new CustomerOutputLinks(f.graph); };
  f.open();
  const account = await f.auth.register({ username: "link-owner", password }, "fixture");
  f.owner = account.customer.id;
  f.graph.addSource({ id: "fixture-source", protocol: "fixture", name: "Fixture", configuration: {}, customerId: f.owner });
  f.collection = f.graph.createCollection({ name: "Private", sourceIds: ["fixture-source"], customerId: f.owner }).id;
  f.login = () => f.auth.login({ username: "link-owner", password }, "fixture");
  f.close = async () => { await f.auth.close(); f.graph.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return f;
}

test("installation credentials are password-encrypted and persist without using the server key", async () => {
  const f = await fixture();
  try {
    const credentials = f.links.credentials(f.collection), row = f.links.row(f.collection);
    assert.notEqual(credentials.token, f.collection);
    assert.notEqual(credentials.token, credentials.password);
    assert.ok(!JSON.stringify(row).includes(credentials.token));
    assert.ok(!JSON.stringify(row).includes(credentials.password));
    assert.throws(() => f.graph.secrets.open(row.encrypted_credentials));
    assert.equal(f.links.resolve(credentials.token), f.collection);
    assert.equal(f.links.authenticate(credentials.username, credentials.password), f.collection);
    assert.throws(() => f.links.resolve(f.collection), { status: 401 });
    assert.throws(() => f.links.authenticate(credentials.username, "0".repeat(64)), { status: 401 });
    await f.auth.close(); f.graph.close(); f.open();
    assert.throws(() => f.links.resolve(credentials.token), { status: 423 });
    assert.throws(() => f.links.credentials(f.collection), { status: 423 });
    await f.login();
    assert.deepEqual(f.links.credentials(f.collection), credentials);
    const { snapshot } = require("../backup.cjs");
    assert.equal((await snapshot(f.file, path.join(f.dir, "backup.db"), { secret })).schema, 16);
  } finally { await f.close(); }
});

test("rotation, revocation and account revision changes invalidate public links", async () => {
  const f = await fixture();
  try {
    const first = f.links.credentials(f.collection);
    const held = new (require("../protocols/library").OutputLibrary)({ graph: f.graph }, f.graph.collection(f.collection), { authorize: () => f.links.resolve(first.token) });
    assert.equal(held.collection.id, f.collection);
    const second = f.links.rotate(f.collection);
    assert.throws(() => held.collection, { status: 401 }, "An in-flight library context cannot revive after link rotation");
    assert.throws(() => f.links.resolve(first.token), { status: 401 });
    assert.throws(() => f.links.authenticate(first.username, first.password), { status: 401 });
    assert.equal(f.links.resolve(second.token), f.collection);
    f.auth.lockVault(f.owner);
    assert.throws(() => f.links.rotate(f.collection), { status: 423 });
    assert.throws(() => f.links.authenticate(second.username, second.password), { status: 423 });
    await f.login();
    assert.ok(f.links.revoke(f.collection));
    assert.throws(() => f.links.resolve(second.token), { status: 401 });
    const third = f.links.credentials(f.collection);
    f.graph.sql("UPDATE Customers SET revision=revision+1 WHERE id=?").run(f.owner);
    await f.login();
    assert.throws(() => f.links.resolve(third.token), { status: 401 });
    assert.throws(() => f.links.credentials(f.collection), { status: 401 });
    assert.equal(f.links.resolve(f.links.rotate(f.collection).token), f.collection);
  } finally { await f.close(); }
});

test("ciphertext cannot be swapped between customer libraries and links cascade on deletion", async () => {
  const f = await fixture();
  try {
    const other = f.graph.createCollection({ name: "Other", sourceIds: ["fixture-source"], customerId: f.owner }).id;
    f.links.credentials(f.collection); f.links.credentials(other);
    f.graph.sql("UPDATE CustomerOutputLinks SET encrypted_credentials=? WHERE collection_id=?").run(f.links.row(f.collection).encrypted_credentials, other);
    assert.throws(() => f.links.credentials(other));
    f.links.rotate(other);
    f.graph.sql("DELETE FROM Collections WHERE id=?").run(other);
    assert.equal(f.links.row(other), undefined);
    const admin = f.graph.createCollection({ name: "Admin", sourceIds: ["fixture-source"] }).id;
    assert.throws(() => f.links.credentials(admin), { status: 404 });
  } finally { await f.close(); }
});

test("schema fourteen migration adds link storage without changing canonical IDs", async () => {
  const f = await fixture();
  try {
    const [media] = f.graph.ingest("fixture-source", [{ sourceKey: "movie", type: "movie", title: "Fixture" }]);
    const synthetic = f.graph.synthetic("xtream", media);
    f.graph.db.exec("DROP TABLE CustomerOutputLinks; PRAGMA user_version=14");
    await f.auth.close(); f.graph.close(); f.open();
    assert.equal(f.graph.db.pragma("user_version", { simple: true }), 16);
    assert.equal(f.graph.synthetic("xtream", media), synthetic);
    assert.equal(f.graph.sql("SELECT count(*) n FROM CustomerOutputLinks").get().n, 0);
  } finally { await f.close(); }
});

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MediaGraph } = require("../core/graph");
const { CustomerAuth } = require("../core/customer-auth");
const { OutputAuth } = require("../core/output-auth");
const { OutputLibrary } = require("../protocols/library");
const password = "output owner password for the local fixture";
async function fixture() {
  const graph = new MediaGraph(":memory:", { secret: "output vault fixture server secret long enough" });
  const auth = new CustomerAuth(graph), account = await auth.register({ username: "output-owner", password }, "fixture");
  graph.addSource({ id: "owned", name: "Owned", protocol: "fixture", configuration: {}, customerId: account.customer.id });
  graph.ingest("owned", [{ type: "movie", sourceKey: "one", title: "First" }, { type: "movie", sourceKey: "two", title: "Second" }]);
  const collection = graph.createCollection({ name: "Owned library", sourceIds: ["owned"], customerId: account.customer.id });
  const engine = { graph, page: options => graph.page(options), synthetic: (protocol, id) => graph.synthetic(protocol, id), artwork: (id, sourceIds) => graph.artwork(id, sourceIds) };
  return { graph, auth, account, collection, engine, library: () => new OutputLibrary(engine, collection, {}),
    login: () => auth.login({ username: "output-owner", password }, "fixture"), async close() { await auth.close(); graph.close(); } };
}

test("output credentials cannot authenticate or verify sessions while the owning vault is locked", async () => {
  const f = await fixture(), output = new OutputAuth(f.graph);
  try {
    const credentials = output.provision(f.collection.id, "jellyfin");
    const session = output.authenticate("jellyfin", credentials.username, credentials.password, { deviceId: "fixture" });
    assert.equal(output.verify("jellyfin", session.token).collectionId, f.collection.id);
    f.auth.lockVault(f.account.customer.id);
    assert.throws(() => output.verify("jellyfin", session.token), { status: 423 });
    assert.throws(() => output.authenticate("jellyfin", credentials.username, credentials.password, { deviceId: "fixture" }), { status: 423 });
    assert.throws(() => output.provision(f.collection.id, "emby"), { status: 423 });
    assert.throws(() => output.rotate(f.collection.id, "jellyfin"), { status: 423 });
    await f.login();
    assert.equal(output.verify("jellyfin", session.token).collectionId, f.collection.id);
  } finally { await f.close(); }
});

test("native descriptors, Xtream account replies and M3U exports check access when invoked", async () => {
  const f = await fixture();
  try {
    const library = f.library();
    const boss = require("../protocols/boss").createBossOutput(library, "https://boss.example/a/fixture");
    const credentials = { server: "https://boss.example/xtream", username: "output", password: "output-token" };
    const xtream = require("../protocols/xtream").createXtreamOutput(library, credentials);
    const playlist = require("../protocols/m3u").playlist(library, credentials);
    f.auth.lockVault(f.account.customer.id);
    assert.throws(() => boss.descriptor(), { status: 423 });
    await assert.rejects(xtream.render(new URLSearchParams()).next(), { status: 423 });
    await assert.rejects(playlist.next(), { status: 423 });
  } finally { await f.close(); }
});

test("XMLTV stops within an already loaded programme page when the vault locks", async () => {
  const f = await fixture();
  try {
    const [channelId] = f.graph.ingest("owned", [{ type: "channel", title: "Fixture TV", sourceKey: "tv" }]);
    for (let i = 0; i < 2; i++) f.graph.sql("INSERT INTO EPGEvents(source_id,channel_id,source_key,title,starts_at,ends_at) VALUES(?,?,?,?,?,?)").run("owned", channelId, `event-${i}`, `Programme ${i}`, 1000 + i * 1000, 2000 + i * 1000);
    const guide = require("../protocols/m3u").xmltv(f.library());
    assert.match((await guide.next()).value, /<tv /);
    assert.match((await guide.next()).value, /<channel /);
    assert.match((await guide.next()).value, /Programme 0/);
    f.auth.lockVault(f.account.customer.id);
    await assert.rejects(guide.next(), { status: 423 });
  } finally { await f.close(); }
});

test("catalogue exports stop if the library revision changes after a page is loaded", async () => {
  const f = await fixture();
  try {
    const iterator = f.library().items({ types: ["movie"] });
    assert.equal((await iterator.next()).done, false);
    f.graph.updateCollection(f.collection.id, { name: "Renamed", sourceIds: ["owned"], revision: f.collection.revision });
    await assert.rejects(iterator.next(), { status: 409 });
  } finally { await f.close(); }
});

test("shared output catalogue access rejects lock, including items remaining in an already fetched page", async () => {
  const f = await fixture();
  try {
    const library = f.library(), iterator = library.items({ types: ["movie"] });
    assert.equal((await iterator.next()).done, false);
    f.auth.lockVault(f.account.customer.id);
    await assert.rejects(iterator.next(), { status: 423 });
    assert.throws(() => library.page({ types: ["movie"] }), { status: 423 });
    assert.throws(() => library.count(), { status: 423 });
    assert.throws(() => library.capabilities, { status: 423 });
    assert.throws(() => f.library(), { status: 423 });
    await f.login();
    assert.throws(() => library.page({ types: ["movie"] }), { status: 423 }, "Old request contexts must not revive after a later login");
    assert.equal(f.library().page({ types: ["movie"] }).length, 2);
  } finally { await f.close(); }
});

test("an unowned collection containing a customer source cannot bypass its source vault", async () => {
  const f = await fixture();
  try {
    const mixed = f.graph.createCollection({ name: "Mixed fixture", sourceIds: ["owned"] });
    f.auth.lockVault(f.account.customer.id);
    assert.throws(() => new OutputLibrary(f.engine, mixed, {}), { status: 423 });
    assert.throws(() => new OutputAuth(f.graph).provision(mixed.id, "jellyfin"), { status: 423 });
    f.graph.addSource({ id: "admin", name: "Admin", protocol: "fixture", configuration: {} });
    const admin = f.graph.createCollection({ name: "Admin library", sourceIds: ["admin"] });
    assert.doesNotThrow(() => new OutputLibrary(f.engine, admin, {}));
    assert.ok(new OutputAuth(f.graph).provision(admin.id, "jellyfin").password);
  } finally { await f.close(); }
});

test("stored playback choices use source vault keys and reject cross-session ciphertext swaps", async () => {
  const f = await fixture(), output = new OutputAuth(f.graph), state = new (require("../core/output-state").OutputState)(f.graph, output, "jellyfin");
  try {
    f.graph.addSource({ id: "second-owned", name: "Second", protocol: "fixture", configuration: {}, customerId: f.account.customer.id });
    f.graph.updateCollection(f.collection.id, { name: "Merged", sourceIds: ["owned", "second-owned"], revision: f.collection.revision });
    const credentials = output.provision(f.collection.id, "jellyfin");
    const session = output.authenticate("jellyfin", credentials.username, credentials.password, { deviceId: "fixture" });
    const media = f.graph.page({ sourceIds: ["owned"], types: ["movie"] })[0];
    const choices = [{ id: "one", sourceId: "owned", resource: { url: "https://provider.example/movie?token=private-play-token" }, requiredHeaders: { Authorization: "Bearer private-header" }, quality: "1080p" },
      { id: "two", sourceId: "second-owned", resource: { url: "https://another.example/movie?token=private-choice" }, requiredHeaders: {}, quality: "4K" }];
    const first = state.create(session.token, media, choices), second = state.create(session.token, media, choices);
    const stored = f.graph.sql("SELECT resource_data FROM OutputPlays WHERE id=?").get(first.id).resource_data;
    assert.ok(!stored.includes("private-")); assert.throws(() => f.graph.secrets.open(stored));
    assert.throws(() => f.graph.secrets.open(JSON.parse(stored.slice(14))[0].encrypted));
    assert.deepEqual(state.resources(session.token, first.id, media), choices);
    const manyChoices = Array.from({ length: 201 }, (_, index) => ({ ...choices[index % 2], id: `choice-${index}` }));
    const many = state.create(session.token, media, manyChoices);
    assert.deepEqual(state.resources(session.token, many.id, media), manyChoices, "Merged choices must not inherit a single-source limit");
    f.graph.sql("UPDATE OutputPlays SET resource_data=? WHERE id=?").run(stored, second.id);
    assert.throws(() => state.resources(session.token, second.id, media), { status: 403 });
    const anotherSession = output.authenticate("jellyfin", credentials.username, credentials.password, { deviceId: "another-device" });
    const tokenHash = value => require("node:crypto").createHash("sha256").update(value).digest("hex");
    f.graph.sql("UPDATE OutputPlays SET token_hash=? WHERE id=?").run(tokenHash(anotherSession.token), first.id);
    assert.throws(() => state.resources(anotherSession.token, first.id, media), { status: 403 });
    f.graph.sql("UPDATE OutputPlays SET token_hash=? WHERE id=?").run(tokenHash(session.token), first.id);
    f.auth.lockVault(f.account.customer.id);
    assert.throws(() => state.resources(session.token, first.id, media), { status: 423 });
    assert.throws(() => state.read(session, media), { status: 423 });
    await f.login(); assert.deepEqual(state.resources(session.token, first.id, media), choices);
    f.graph.sql("UPDATE OutputPlays SET resource_data=? WHERE id=?").run(f.graph.secrets.seal(choices), first.id);
    assert.throws(() => state.resources(session.token, first.id, media), { status: 409 });
    assert.throws(() => state.create(session.token, media, [{ ...choices[0], sourceId: "not-in-library" }]), { status: 403 });
  } finally { await f.close(); }
});

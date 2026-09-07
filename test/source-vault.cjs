"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MediaGraph } = require("../core/graph");
const { CustomerAuth } = require("../core/customer-auth");
const { SourceRegistry } = require("../core/registry");
const { ResolverEngine } = require("../core/resolver");
const { capabilities } = require("../core/model");
const secret = "administrator key cannot decrypt customer sources";
const password = "customer unlock password for source fixtures";
const declaration = capabilities({ streams: true, types: ["movie"] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-source-vault-")), file = path.join(dir, "graph.db");
  const graph = new MediaGraph(file, { secret }), auth = new CustomerAuth(graph);
  const account = await auth.register({ username: "source-owner", password }, "fixture");
  graph.addSource({ id: "owned", protocol: "fixture", name: "Owned", configuration: { password: "private-upstream-password" }, customerId: account.customer.id, capabilities: declaration });
  const [mediaId] = graph.ingest("owned", [{ type: "movie", title: "Fixture film", sourceKey: "movie", externalIDs: { imdb: "tt1234567" }, artwork: { poster: { url: "https://upstream.example/poster", headers: { Authorization: "private-artwork" } } }, resolverData: { url: "https://upstream.example/video?token=private-token" } }]);
  return { dir, file, graph, auth, account, mediaId, async login() { return auth.login({ username: "source-owner", password }, "fixture"); },
    async close() { await auth.close(); graph.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("owned source configurations and mappings survive restart but cannot be read using the server key", async () => {
  const f = await fixture(); let graph, auth;
  try {
    const storedSource = f.graph.sql("SELECT name,configuration FROM Sources WHERE id='owned'").get(), config = storedSource.configuration;
    const mapping = f.graph.sql("SELECT resolver_data FROM SourceMappings WHERE source_id='owned'").get().resolver_data;
    const artwork = f.graph.sql("SELECT resource FROM Artwork WHERE source_id='owned'").get().resource;
    for (const value of [config, mapping, artwork]) {
      assert.match(value, /^boss-vault:1:/); assert.ok(!value.includes("private-"));
      assert.throws(() => f.graph.secrets.open(value));
    }
    const id = f.graph.synthetic("xtream", f.mediaId), canonical = f.graph.media(f.mediaId).canonicalId;
    await f.auth.close(); graph = new MediaGraph(f.file, { secret }); auth = new CustomerAuth(graph);
    assert.equal(graph.fromSynthetic("xtream", id).canonicalId, canonical);
    assert.throws(() => graph.source("owned", { credentials: true }), { status: 423 });
    assert.throws(() => graph.mappings(f.mediaId, ["owned"]), { status: 423 });
    assert.throws(() => graph.artwork(f.mediaId, ["owned"]), { status: 423 });
    assert.throws(() => graph.addSource({ id: "locked-new", protocol: "fixture", name: "New", configuration: {}, customerId: f.account.customer.id }), { status: 423 });
    assert.equal(graph.source("locked-new"), null);
    graph.updateSource("owned", { enabled: false });
    assert.equal(graph.sql("SELECT configuration FROM Sources WHERE id='owned'").get().configuration, config);
    assert.equal(graph.sql("SELECT name FROM Sources WHERE id='owned'").get().name, storedSource.name);
    assert.throws(() => graph.updateSource("owned", { name: "Renamed without password" }), { status: 423 });
    await auth.login({ username: "source-owner", password }, "restart");
    graph.updateSource("owned", { name: "Renamed with password", enabled: true });
    assert.equal(graph.source("owned").name, "Renamed with password");
    assert.equal(graph.source("owned", { credentials: true }).configuration.password, "private-upstream-password");
    assert.equal(graph.mappings(f.mediaId, ["owned"])[0].resolverData.url, "https://upstream.example/video?token=private-token");
    graph.db.exec("VACUUM");
    assert.equal(graph.artwork(f.mediaId, ["owned"]).poster.resource.headers.Authorization, "private-artwork");
  } finally { if (auth) await auth.close(); graph?.close(); await f.close(); }
});

test("source ciphertext is bound to owner, source, purpose and stable mapping identity", async () => {
  const f = await fixture(), { graph } = f;
  try {
    graph.addSource({ id: "second", protocol: "fixture", name: "Second", configuration: {}, customerId: f.account.customer.id });
    const config = graph.sql("SELECT configuration FROM Sources WHERE id='owned'").get().configuration;
    const mapping = graph.sql("SELECT resolver_data FROM SourceMappings WHERE source_id='owned'").get().resolver_data;
    assert.throws(() => graph.sourceOpen("second", "source-config", "configuration", config), { status: 403 });
    assert.throws(() => graph.sourceOpen("owned", "source-config", "configuration", mapping), { status: 403 });
    assert.throws(() => graph.sourceOpen("owned", "source-mapping", ["movie", "another"], mapping), { status: 403 });
    const other = await f.auth.register({ username: "other-owner", password }, "fixture-other");
    graph.sql("UPDATE CustomerSources SET customer_id=? WHERE source_id='second'").run(other.customer.id);
    assert.throws(() => graph.sourceOpen("second", "source-config", "configuration", config), { status: 403 });
    assert.throws(() => graph.sourceOpen("owned", "source-config", "configuration", graph.secrets.seal({ password: "legacy" })), { status: 409 });
    // Canonical merges move media IDs, not the stable source-mapping identity.
    graph.addSource({ id: "admin", protocol: "fixture", name: "Admin", configuration: {} });
    const [keep] = graph.ingest("admin", [{ type: "movie", title: "Other identity", sourceKey: "a", externalIDs: { tmdb: "42" } }]);
    graph.db.transaction(() => graph.merge(keep, f.mediaId))();
    assert.equal(graph.mappings(keep, ["owned"])[0].resolverData.url, "https://upstream.example/video?token=private-token");
    assert.equal(graph.artwork(keep, ["owned"]).poster.resource.headers.Authorization, "private-artwork");
  } finally { await f.close(); }
});

test("resolution caches retain direct choices encrypted and refuse cached reads after lock", async () => {
  const f = await fixture(), { graph, auth } = f, registry = new SourceRegistry(graph);
  let calls = 0;
  registry.register("fixture", source => ({ id: source.id, capabilities: declaration, async resolve() {
    calls++; return [{ url: "https://upstream.example/one?token=private-one", quality: "1080p" }, { url: "https://upstream.example/two?token=private-two", quality: "4K", requiredHeaders: { Authorization: "Bearer private-header" } }];
  } }));
  const resolver = new ResolverEngine(graph, registry);
  try {
    const first = await resolver.resolve(f.mediaId, { allowedSourceIds: ["owned"] });
    assert.equal(first.candidates.length, 2); assert.equal(calls, 1);
    const cache = graph.sql("SELECT encrypted_result FROM ResolutionCache").get().encrypted_result;
    assert.match(cache, /^boss-vault:1:/); assert.ok(!cache.includes("private-")); assert.throws(() => graph.secrets.open(cache));
    auth.lockVault(f.account.customer.id); assert.equal(registry.clients.size, 0);
    await assert.rejects(resolver.resolve(f.mediaId, { allowedSourceIds: ["owned"] }), { status: 423 });
    await f.login();
    assert.equal((await resolver.resolve(f.mediaId, { allowedSourceIds: ["owned"] })).candidates.length, 2);
    assert.equal(calls, 1, "An unexpired encrypted cache can be read only after password unlock");
  } finally { resolver.limiter.close(); await f.close(); }
});

test("late adapter initialization and methods cannot return secrets after the vault locks", async () => {
  const f = await fixture(), registry = new SourceRegistry(f.graph), initializing = deferred(), started = deferred();
  let calls = 0;
  registry.register("fixture", async source => {
    calls++; if (calls === 1) { started.resolve(); await initializing.promise; }
    return { id: source.id, capabilities: declaration, async resolve() { return [{ url: "https://upstream.example/private" }]; } };
  });
  try {
    const first = registry.get("owned"); const rejected = assert.rejects(first, { status: 423 });
    await started.promise; f.auth.lockVault(f.account.customer.id); await rejected;
    assert.equal(registry.clients.size, 0); assert.equal(registry.listeners.size, 0);
    await f.login(); const current = await registry.get("owned");
    initializing.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(await registry.get("owned"), current); assert.equal(calls, 2);
    const response = deferred(), resolving = deferred();
    registry.invalidate("owned");
    registry.factories.set("fixture", source => ({ id: source.id, capabilities: declaration, async resolve() { resolving.resolve(); return response.promise; } }));
    const adapter = await registry.get("owned"), pending = adapter.resolve(), failed = assert.rejects(pending, { status: 423 });
    await resolving.promise; f.auth.lockVault(f.account.customer.id); await failed;
    response.resolve([{ url: "https://upstream.example/late-private" }]);
    assert.throws(() => adapter.resolve(), { status: 423 });
    assert.equal(registry.clients.size, 0);
  } finally { initializing.resolve(); await f.close(); }
});

test("customer source-response caches encrypt values and prevent late writes from old unlocks", async () => {
  const f = await fixture(), { createCaches, sourceCaches } = require("../core/cache"), caches = createCaches();
  try {
    const scoped = sourceCaches(f.graph, "owned", caches).sourceResponses;
    scoped.set("private-query-key", { url: "https://upstream.example/?token=private-token" }, 30000);
    assert.ok(!JSON.stringify([...caches.sourceResponses.values]).includes("private-"));
    assert.equal(scoped.get("private-query-key").url, "https://upstream.example/?token=private-token");
    f.auth.lockVault(f.account.customer.id);
    assert.throws(() => scoped.get("private-query-key"), { status: 423 });
    await f.login();
    assert.throws(() => scoped.set("late", { token: "late-private" }, 30000), { status: 423 });
    assert.equal(sourceCaches(f.graph, "owned", caches).sourceResponses.get("private-query-key").url, "https://upstream.example/?token=private-token");
    assert.equal(caches.sourceResponses.values.size, 1);
  } finally { await f.close(); }
});

test("vault locking aborts scoped upstream fetches and rejects the outstanding adapter result", async () => {
  const f = await fixture(), registry = new SourceRegistry(f.graph), started = deferred(), response = deferred(), original = global.fetch;
  let signal;
  global.fetch = (_url, options) => { signal = options.signal; started.resolve(); return response.promise; };
  registry.register("fixture", source => ({ id: source.id, capabilities: declaration, async resolve() {
    const result = await require("../core/network").networkFetch("https://upstream.example/api");
    return result.json();
  } }));
  try {
    const adapter = await registry.get("owned"), pending = adapter.resolve(), rejected = assert.rejects(pending, { status: 423 });
    await started.promise; assert.equal(signal.aborted, false);
    f.auth.lockVault(f.account.customer.id); assert.equal(signal.aborted, true); await rejected;
    response.resolve(new Response("[]"));
  } finally { response.resolve(new Response("[]")); global.fetch = original; await f.close(); }
});

test("quarantined customer records are password-encrypted and absent from administrator identity reviews", async () => {
  const f = await fixture(), registry = new SourceRegistry(f.graph);
  registry.register("fixture", source => ({ id: source.id, capabilities: capabilities({ catalog: true, types: ["movie"] }),
    async catalog() { return { items: [{ type: "movie", sourceKey: "movie", title: "Conflicting identity", externalIDs: { imdb: "tt7654321" }, resolverData: { password: "quarantined-private" } }], nextCursor: null }; } }));
  try {
    await new (require("../core/ingestion").CatalogueIngestor)(f.graph, registry).ingest("owned", { key: "movies" });
    const row = f.graph.sql("SELECT * FROM IdentityReviews").get(); assert.ok(row);
    assert.match(row.encrypted_input, /^boss-vault:1:/); assert.ok(!row.encrypted_input.includes("quarantined-private"));
    assert.throws(() => f.graph.secrets.open(row.encrypted_input));
    assert.equal(f.graph.sourceOpen("owned", "quarantine", ["movies", "movie", "movie"], row.encrypted_input).resolverData.password, "quarantined-private");
    assert.deepEqual(require("../core/identity-review").reviewPage(f.graph).reviews, []);
    f.auth.lockVault(f.account.customer.id);
    assert.deepEqual(require("../core/identity-review").reviewPage(f.graph).reviews, []);
  } finally { await f.close(); }
});

test("locking removes queued resolver work before it can invoke the provider", async () => {
  const f = await fixture(), registry = new SourceRegistry(f.graph), resolver = new ResolverEngine(f.graph, registry, { globalConcurrency: 1 });
  let calls = 0;
  registry.register("fixture", source => ({ id: source.id, capabilities: declaration, async resolve() { calls++; return []; } }));
  try {
    await resolver.limiter.acquire();
    const pending = resolver.resolve(f.mediaId, { allowedSourceIds: ["owned"] }), rejected = assert.rejects(pending, { status: 423 });
    assert.equal(resolver.limiter.queue.length, 1);
    f.auth.lockVault(f.account.customer.id); await rejected;
    assert.equal(resolver.limiter.queue.length, 0); assert.equal(resolver.pending.size, 0); assert.equal(calls, 0);
    assert.equal(f.graph.sql("SELECT count(*) n FROM ResolutionCache").get().n, 0);
  } finally { resolver.limiter.release(); resolver.limiter.close(); await f.close(); }
});

test("deferred catalogue iteration is cancelled on lock while iterator cleanup remains possible", async () => {
  const f = await fixture(), registry = new SourceRegistry(f.graph), started = deferred(), release = deferred();
  let cleaned = false;
  registry.register("fixture", source => ({ id: source.id, capabilities: capabilities({ catalog: true, types: ["movie"] }),
    async *scanCatalog() { try { started.resolve(); await release.promise; yield { items: [{ title: "private" }], nextCursor: null }; } finally { cleaned = true; } } }));
  try {
    const adapter = await registry.get("owned"), iterator = adapter.scanCatalog();
    const pending = iterator.next(), rejected = assert.rejects(pending, { status: 423 });
    await started.promise; f.auth.lockVault(f.account.customer.id); await rejected;
    release.resolve(); await iterator.return(); assert.equal(cleaned, true);
    assert.throws(() => iterator.next(), { status: 423 });
  } finally { release.resolve(); await f.close(); }
});

test("startup discovery excludes customer sources and returns enabled administrator sources lazily", async () => {
  const f = await fixture();
  try {
    f.graph.addSource({ id: "admin-enabled", name: "Admin", protocol: "fixture", configuration: {} });
    f.graph.addSource({ id: "admin-disabled", name: "Disabled", protocol: "fixture", configuration: {} });
    f.graph.updateSource("admin-disabled", { enabled: false });
    const rows = f.graph.startupSources();
    assert.equal(typeof rows.next, "function");
    assert.deepEqual([...rows].map(row => row.id), ["admin-enabled"]);
    f.auth.lockVault(f.account.customer.id);
    assert.deepEqual([...f.graph.startupSources()].map(row => row.id), ["admin-enabled"]);
  } finally { await f.close(); }
});

test("ingestion after restart refuses locked sources before queueing and succeeds after password login", async () => {
  const f = await fixture();
  const engine = new (require("../core/engine").MediaEngine)(f.file, { secret }), auth = new CustomerAuth(engine.graph);
  let called = 0;
  engine.registry.factories.set("fixture", source => ({ id: source.id, capabilities: capabilities({ catalog: true, types: ["movie"] }),
    catalogs: [{ key: "movies", type: "movie", enumerable: true }],
    async catalog() { called++; return { items: [], nextCursor: null }; } }));
  try {
    const pending = engine.ingestSource("owned");
    assert.equal(engine.sourceTasks.size, 0);
    await assert.rejects(pending, { status: 423 });
    await assert.rejects(engine.runSource("owned"), { status: 423 });
    assert.equal(called, 0); assert.equal(engine.graph.sql("SELECT count(*) n FROM SourceSync").get().n, 0);
    assert.equal(engine.graph.sql("SELECT count(*) n FROM IngestionJobs").get().n, 0);
    await auth.login({ username: "source-owner", password }, "restart-fixture");
    await engine.ingestSource("owned");
    assert.equal(called, 1); assert.equal(engine.sourceTasks.size, 0);
    assert.equal(engine.graph.sql("SELECT status FROM SourceSync WHERE source_id='owned'").get().status, "complete");
  } finally { await auth.close(); await engine.close(); await f.close(); }
});

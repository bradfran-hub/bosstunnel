"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MediaGraph } = require("../core/graph");
const { SourceRegistry } = require("../core/registry");
const { ResolverEngine } = require("../core/resolver");
const { CatalogueIngestor } = require("../core/ingestion");
const { capabilities } = require("../core/model");
const secret = "canonical-resolver-test-encryption-secret";
test("queued resolver work cancels independently without consuming a slot or starting its task", async () => {
  const { WorkLimiter } = require("../core/limiter");
  const limiter = new WorkLimiter({ concurrency: 1, maxQueued: 2 });
  await limiter.acquire();
  const controller = new AbortController(); let started = false;
  const queued = limiter.run(() => { started = true; }, { signal: controller.signal });
  const rejected = assert.rejects(queued, /cancelled/);
  assert.equal(limiter.queue.length, 1);
  controller.abort(new Error("cancelled")); await rejected;
  assert.equal(limiter.queue.length, 0); assert.equal(limiter.active, 1); assert.equal(started, false);
  limiter.release(); assert.equal(limiter.active, 0);
  await assert.rejects(limiter.run(() => { started = true; }, { signal: controller.signal }), /cancelled/);
  assert.equal(started, false);
  await limiter.run(() => { started = true; }); assert.equal(started, true); assert.equal(limiter.active, 0);
  limiter.close();
});
test("subtitle cancellation interrupts source startup and running work without waiting for ignored signals", async () => {
  const { MediaEngine } = require("../core/engine");
  const engine = new MediaEngine(":memory:", { secret });
  let finishStartup, finishSubtitles, calls = 0;
  try {
    engine.registry.register("slow-subtitles", async source => {
      await new Promise(resolve => { finishStartup = resolve; });
      return { id: source.id, capabilities: capabilities({ subtitles: true, types: ["movie"] }), catalogs: [],
        async subtitles() { calls++; return new Promise(resolve => { finishSubtitles = resolve; }); } };
    });
    engine.graph.addSource({ id: "subtitles", protocol: "slow-subtitles", name: "Slow", configuration: {}, capabilities: { subtitles: true, types: ["movie"] } });
    const [id] = engine.graph.ingest("subtitles", [{ type: "movie", sourceKey: "movie", title: "Owned" }]);
    for (const phase of ["startup", "lookup"]) {
      const controller = new AbortController();
      const request = engine.subtitles(id, { allowedSourceIds: ["subtitles"], signal: controller.signal });
      const rejected = assert.rejects(request, /cancelled/);
      await new Promise(resolve => setImmediate(resolve));
      controller.abort(new Error("cancelled")); await rejected;
      assert.equal(engine.subtitleRequests.size, 0); assert.equal(engine.resolver.limiter.active, 0);
      if (phase === "startup") { assert.equal(calls, 0); finishStartup(); await new Promise(resolve => setImmediate(resolve)); }
      else { assert.equal(calls, 1); finishSubtitles([]); }
    }
  } finally { finishStartup?.(); finishSubtitles?.([]); await engine.close(); }
});
test("catalogue identity conflicts are quarantined without blocking valid records or changing trusted identities", async () => {
  const { graph, registry, source } = setup();
  let conflict = true;
  source("catalogue", { async catalog() { return { items: [
    { type: "movie", title: "Conflicting input", sourceKey: "existing", externalIDs: { imdb: conflict ? "tt0000002" : "tt0000001" }, resolverData: { url: "https://private.example/secret" } },
    { type: "movie", title: "Valid input", sourceKey: "valid", externalIDs: { imdb: "tt0000003" } }
  ], nextCursor: null }; } }, { catalog: true, types: ["movie"] });
  try {
    const [existing] = graph.ingest("catalogue", [{ type: "movie", title: "Trusted", sourceKey: "existing", externalIDs: { imdb: "tt0000001" } }]);
    const ingestor = new CatalogueIngestor(graph, registry);
    const result = await ingestor.ingest("catalogue", { key: "all" });
    assert.equal(result.imported, 1);
    assert.equal(graph.media(existing).externalIDs.imdb, "tt0000001");
    assert.equal(graph.page({ sourceIds: ["catalogue"] }).length, 2);
    const reviews = graph.sql("SELECT * FROM IdentityReviews").all();
    assert.equal(reviews.length, 1);
    assert.ok(!JSON.stringify(reviews).includes("private.example"));
    const { reviewPage } = require("../core/identity-review");
    const page = reviewPage(graph);
    assert.equal(page.reviews[0].title, "Conflicting input");
    assert.equal(page.reviews[0].sourceName, "catalogue");
    assert.equal(page.reviews[0].matches[0].title, "Trusted");
    assert.deepEqual(page.reviews[0].matches[0].matchedBy, ["source"]);
    assert.ok(!JSON.stringify(page).includes("private.example"));
    assert.throws(() => reviewPage(graph, -1), /Invalid review cursor/);
    assert.equal(graph.sql("SELECT error_code FROM IngestionJobs").get().error_code, "IDENTITY_REVIEW");
    conflict = false;
    await ingestor.ingest("catalogue", { key: "all" }, { refresh: true });
    assert.equal(graph.sql("SELECT count(*) n FROM IdentityReviews").get().n, 0);
    assert.equal(graph.sql("SELECT error_code FROM IngestionJobs").get().error_code, null);
  } finally { graph.close(); }
});
test("catalogue refresh schedules persist, serialize sources, resume failures and count authorized titles", async () => {
  const { CatalogueRefresh } = require("../core/catalogue-refresh");
  let now = 1000;
  const graph = new MediaGraph(":memory:", { secret, clock: () => now });
  graph.addSource({ id: "source", protocol: "fixture", name: "Source", configuration: {} });
  graph.ingest("source", [{ sourceKey: "movie", type: "movie", title: "Film" }]);
  const calls = []; let reject = false, release;
  const engine = { graph, sourceTasks: new Map(), async ingestSource(id, options) {
    calls.push({ id, options });
    if (release) await release;
    if (reject) throw reject instanceof Error ? reject : new Error("secret upstream details");
  } };
  try {
    let scheduler = new CatalogueRefresh(engine, { intervalMs: 100, retryMs: 10 });
    await scheduler.tick(); assert.equal(calls.length, 0);
    assert.equal(scheduler.status().counts.movie, 1);
    assert.equal(scheduler.status().intervalMs, 100);
    assert.equal(new CatalogueRefresh(engine).status().intervalMs, 86400000);
    scheduler = new CatalogueRefresh(engine, { intervalMs: 100, retryMs: 10 });
    now += 100;
    engine.sourceTasks.set("source", Promise.resolve()); await scheduler.tick(); assert.equal(calls.length, 0);
    engine.sourceTasks.clear();
    let finish; release = new Promise(resolve => { finish = resolve; });
    const a = scheduler.tick(), b = scheduler.tick(); assert.equal(a, b); finish(); await a; release = null;
    assert.deepEqual(calls[0].options, { refresh: true, indexEpisodes: false });
    now += 100; reject = true; await scheduler.tick();
    assert.equal(scheduler.status().sources[0].status, "failed");
    assert.equal(scheduler.status().sources[0].next_at, now + 10);
    assert.ok(!JSON.stringify(scheduler.status()).includes("secret"));
    await scheduler.tick(); assert.equal(calls.length, 2);
    graph.sql("INSERT INTO SourceCatalogs VALUES(?,?)").run("source", "movies");
    graph.sql("INSERT INTO IngestionJobs(source_id,catalog_key,generation,status,imported_count,updated_at) VALUES(?,?,1,'failed',0,?)").run("source", "movies", now);
    now += 10; reject = false; await scheduler.tick();
    assert.equal(calls.at(-1).options.refresh, false);
    assert.equal(scheduler.status().sources[0].failures, 0);
    now += 100; reject = Object.assign(new Error("Rate limited"), { upstreamStatus: 429, retryAfter: 120 });
    await scheduler.tick();
    assert.equal(scheduler.status().sources[0].next_at, now + 120000);
    now += 100; await scheduler.tick(); assert.equal(calls.length, 4);
    scheduler.stop(); now += 120000; await scheduler.tick(); assert.equal(calls.length, 4);
  } finally { graph.close(); }
});
test("resolver concurrency is bounded across independent playback requests", async () => {
  const fixture = setup();
  let active = 0, peak = 0;
  fixture.source("source", { async resolve() {
    active++; peak = Math.max(peak, active);
    try { await new Promise((resolve) => setTimeout(resolve, 10)); return [{ url: "https://media.example/authorized.mp4" }]; }
    finally { active--; }
  } });
  const ids = fixture.graph.ingest("source", Array.from({ length: 12 }, (_, index) => ({ type: "movie", title: `Movie ${index}`, sourceKey: String(index + 1) })));
  const resolver = new ResolverEngine(fixture.graph, fixture.registry, { globalConcurrency: 2, maxQueued: 20 });
  try {
    await Promise.all(ids.map((id) => resolver.resolve(id, { allowedSourceIds: ["source"] })));
    assert.equal(peak, 2); assert.equal(resolver.pending.size, 0); assert.equal(resolver.limiter.queue.length, 0);
  } finally { fixture.graph.close(); }
});

test("resolver queue rejects overflow and releases pending work on shutdown", async () => {
  const { WorkLimiter } = require("../core/limiter");
  const limiter = new WorkLimiter({ concurrency: 1, maxQueued: 1 });
  let release;
  const first = limiter.run(() => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const queued = limiter.run(() => assert.fail("Queued work must not start after close"));
  const rejected = assert.rejects(queued, /shutting down/);
  await assert.rejects(limiter.run(() => {}), /queue is full/);
  limiter.close(); release();
  await Promise.all([first, rejected]);
  assert.equal(limiter.active, 0); assert.equal(limiter.queue.length, 0);
});
function setup() {
  let now = Date.now();
  const graph = new MediaGraph(":memory:", { secret, clock: () => now });
  const registry = new SourceRegistry(graph);
  const fixtures = new Map();
  registry.register("fixture", (source) => fixtures.get(source.id));
  function source(id, methods, declaration = { catalog: false, streams: true, types: ["movie", "episode"], identityNamespaces: ["imdb"] }) {
    const caps = capabilities(declaration);
    graph.addSource({ id, protocol: "fixture", name: id, configuration: {}, capabilities: caps });
    fixtures.set(id, { id, capabilities: caps, ...methods });
  }
  return { graph, registry, source, clock: () => now, advance: (ms) => { now += ms; } };
}
test("output library intersects player capabilities with policy and preserves source authorization", async () => {
  const { OutputLibrary } = require("../protocols/library");
  const { constrainPlaybackContext } = require("../core/profile");
  const { graph, registry, source } = setup();
  const contexts = [];
  let forbidden = 0;
  source("owned", { resolve: async (_media, _mapping, context) => {
    contexts.push(context);
    return [
      { url: "https://media.example/es.mp4", codec: "h264", container: "mp4", resolution: { height: 1080 }, languages: ["es"] },
      { url: "https://media.example/en.mp4", codec: "h264", container: "mp4", resolution: { height: 720 }, languages: ["en"] },
      { url: "https://media.example/4k.mp4", codec: "h264", container: "mp4", resolution: { height: 2160 } },
      { url: "https://media.example/hdr.mp4", codec: "h264", container: "mp4", resolution: { height: 1080 }, hdr: "HDR10" },
      { url: "https://media.example/hevc.mp4", codec: "hevc", container: "mp4", resolution: { height: 720 } },
      { url: "https://media.example/unknown.mp4", container: "mp4" }
    ];
  } });
  source("excluded", { resolve: async () => { forbidden++; return []; } });
  try {
    const [id] = graph.ingest("owned", [{ type: "movie", sourceKey: "film", title: "Owned Film", externalIDs: { imdb: "tt1375666" } }]);
    const collection = graph.createCollection({ name: "Owned", sourceIds: ["owned"] });
    const resolver = new ResolverEngine(graph, registry);
    const library = new OutputLibrary({ graph, resolve: (...args) => resolver.resolve(...args) }, collection, {});
    const context = { codecs: ["h264"], maxHeight: 1080, language: "es", hdr: false,
      strictCapabilities: true, protocols: ["http"], containers: ["mp4"], allowedSourceIds: ["excluded"] };
    const result = await library.resolve(graph.media(id), context);
    assert.equal(result.selected.resource.url, "https://media.example/es.mp4");
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(contexts[0].allowedSourceIds, ["owned"]);
    assert.deepEqual(contexts[0].codecs, ["h264"]);
    assert.equal(contexts[0].maxHeight, 1080);
    assert.equal(contexts[0].hdr, false);
    assert.equal(contexts[0].strictCapabilities, true);
    assert.equal(contexts[0].language, "es");
    assert.equal(forbidden, 0);
    assert.deepEqual(context.allowedSourceIds, ["excluded"], "Caller context must not be mutated");
    graph.updateCollection(collection.id, { ...collection, profile: { codecs: ["h264"], maxHeight: 720, hdr: false, strictCapabilities: true, language: "en" } });
    const restricted = await library.resolve(graph.media(id), { codecs: ["h264", "hevc"], maxHeight: 2160, hdr: true, strictCapabilities: false });
    assert.deepEqual(restricted.candidates.map(item => item.resource.url), ["https://media.example/en.mp4"]);
    assert.equal(contexts[1].strictCapabilities, true);
    const before = contexts.length;
    await assert.rejects(library.resolve(graph.media(id), { codecs: ["hevc"] }), { status: 422 });
    assert.equal(contexts.length, before, "An empty codec intersection must fail before contacting sources");
    assert.deepEqual(constrainPlaybackContext({}, {}).codecs, []);
    assert.throws(() => constrainPlaybackContext({}, { maxHeight: -1 }), { status: 400 });
  } finally { graph.close(); }
});
test("output library rejects playback resolved across a profile revision", async () => {
  const { OutputLibrary } = require("../protocols/library");
  const { graph, registry, source } = setup();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  source("owned", { resolve: async () => { entered(); await paused; return [{ url: "https://media.example/film.mp4", codec: "hevc" }]; } });
  try {
    const [id] = graph.ingest("owned", [{ type: "movie", sourceKey: "film", title: "Film" }]);
    const collection = graph.createCollection({ name: "Owned", sourceIds: ["owned"] });
    const resolver = new ResolverEngine(graph, registry);
    const library = new OutputLibrary({ graph, resolve: (...args) => resolver.resolve(...args) }, collection, {});
    const pending = library.resolve(graph.media(id), {});
    const rejected = assert.rejects(pending, { status: 409 });
    await started;
    graph.updateCollection(collection.id, { ...collection, profile: { codecs: ["h264"] } });
    release();
    await rejected;
    await assert.rejects(library.resolve(graph.media(id), {}), { status: 422 });
  } finally { release(); graph.close(); }
});
test("resolver searches authorized identity providers and ranks compatible HTTP results", async () => {
  const env = setup(); const { graph, registry, source } = env;
  try {
    let forbiddenCalls = 0;
    source("catalog", {}, { catalog: false, streams: false, types: ["movie"] });
    const [id] = graph.ingest("catalog", [{ type: "movie", title: "Inception", sourceKey: "film", externalIDs: { imdb: "tt1375666" } }]);
    source("one", { resolve: async (media, mapping) => { assert.equal(media.externalIDs.imdb, "tt1375666"); assert.equal(mapping, null); return [{ url: "https://one.example/movie.mp4", codec: "h265", resolution: { height: 2160 } }]; } });
    source("two", { resolve: async () => [{ url: "https://debrid.example/resolved.mp4", codec: "h264", resolution: { height: 1080 }, languages: ["en"] }, { url: "https://two.example/movie.mp4", infoHash: "torrent" }, { url: "magnet:?xt=urn:btih:abc" }] });
    source("forbidden", { resolve: async () => { forbiddenCalls++; return []; } });
    const resolver = new ResolverEngine(graph, registry);
    const result = await resolver.resolve(id, { allowedSourceIds: ["one", "two"], output: "xtream", codecs: ["h264"], maxHeight: 1080, language: "en" });
    assert.equal(result.selected.sourceId, "two"); assert.equal(result.candidates.length, 1); assert.equal(forbiddenCalls, 0);
    assert.equal(graph.media(id).playbackState, "UNRESOLVED");
  } finally { graph.close(); }
});
test("failed playback invalidation preserves other sources and newer refreshed resources", async () => {
  const { graph, registry, source } = setup();
  let version = 1;
  let calls = 0;
  source("first", { resolve: async () => { calls++; return [{ url: `https://media.example/version-${version}.mp4` }]; } });
  source("second", { resolve: async () => [{ url: "https://other.example/video.mp4" }] });
  const [id] = graph.ingest("first", [{ type: "movie", title: "Movie", sourceKey: "one", externalIDs: { imdb: "tt1375666" } }]);
  const resolver = new ResolverEngine(graph, registry);
  const context = { allowedSourceIds: ["first", "second"] };
  try {
    const old = (await resolver.resolve(id, context)).candidates.filter((candidate) => candidate.sourceId === "first");
    resolver.invalidatePlayback(id, old);
    assert.equal(graph.sql("SELECT COUNT(*) AS total FROM ResolutionCache WHERE source_id='second'").get().total, 1);
    version = 2;
    const fresh = await resolver.resolve(id, context);
    assert.ok(fresh.candidates.some((candidate) => candidate.resource.url.endsWith("version-2.mp4")));
    resolver.invalidatePlayback(id, old);
    await resolver.resolve(id, context);
    assert.equal(calls, 2, "late failure cannot evict a newly refreshed resource");
    graph.removeSource("first");
    assert.ok((await resolver.resolve(id, context)).candidates.every((candidate) => candidate.sourceId === "second"));
  } finally { graph.close(); }
});
test("resolver cache respects expiry, isolates client context and invalidates credentials", async () => {
  const env = setup(); const { graph, registry, source, clock, advance } = env;
  try {
    let calls = 0;
    source("one", { resolutionTtlMs: 300000, resolve: async () => { calls++; return [{ url: `https://debrid.example/video.mp4?token=private-${calls}`, expiresAt: clock() + 10000, requiredHeaders: { Authorization: "secret-header" } }]; } });
    const [id] = graph.ingest("one", [{ type: "movie", title: "Film", sourceKey: "1" }]);
    const resolver = new ResolverEngine(graph, registry, { clock });
    const ctx = { allowedSourceIds: ["one"], output: "xtream" };
    await Promise.all([resolver.resolve(id, ctx), resolver.resolve(id, ctx)]); assert.equal(calls, 1);
    const row = graph.sql("SELECT * FROM ResolutionCache").get();
    assert.ok(!JSON.stringify(row).includes("secret-header")); assert.ok(!JSON.stringify(row).includes("private-1"));
    advance(6000); await resolver.resolve(id, ctx); assert.equal(calls, 2);
    await resolver.resolve(id, { ...ctx, language: "fr" }); assert.equal(calls, 3);
    graph.updateSource("one", { configuration: { password: "new" } });
    await resolver.resolve(id, ctx); assert.equal(calls, 4);
    graph.updateSource("one", { enabled: false });
    await assert.rejects(resolver.resolve(id, ctx), /No compatible/);
    assert.equal(graph.sql("SELECT count(*) AS n FROM ResolutionCache").get().n, 0);
  } finally { graph.close(); }
});
test("one failed source does not prevent fallback; episode resolver receives series identity", async () => {
  const { graph, registry, source } = setup();
  try {
    source("one", { resolve: async () => { throw new Error("upstream credentials should never be exposed"); } });
    source("two", { resolve: async (media, mapping, context) => { assert.equal(context.series.externalIDs.imdb, "tt0903747"); assert.equal(media.seasonNumber, 1); assert.equal(media.episodeNumber, 1); return [{ url: "https://media.example/episode.mp4" }]; } });
    const [seriesId] = graph.ingest("one", [{ type: "series", title: "Breaking Bad", sourceKey: "show", externalIDs: { imdb: "tt0903747" } }]);
    const [id] = graph.ingest("one", [{ type: "episode", title: "Pilot", sourceKey: "ep1", seriesId, seasonNumber: 1, episodeNumber: 1 }]);
    const result = await new ResolverEngine(graph, registry).resolve(id, { allowedSourceIds: ["one", "two"] });
    assert.equal(result.selected.sourceId, "two"); assert.deepEqual(result.failures, [{ sourceId: "one", code: "SOURCE_RESOLUTION_FAILED" }]);
  } finally { graph.close(); }
});
test("background ingestion checkpoints pages and resumes without resolving playback", async () => {
  const { graph, registry, source } = setup();
  try {
    let fail = true; let resolved = 0; const cursors = [];
    source("one", { catalog: async ({ cursor, limit }) => { cursors.push(cursor); if (cursor === "2" && fail) throw new Error("temporary upstream failure"); const start = Number(cursor || 0); return { items: Array.from({ length: Math.min(limit, 5 - start) }, (_, index) => ({ type: "movie", title: `Movie ${start + index}`, sourceKey: String(start + index) })), nextCursor: start + limit < 5 ? String(start + limit) : null }; }, resolve: async () => { resolved++; return []; } }, { catalog: true, streams: true, types: ["movie"] });
    const ingest = new CatalogueIngestor(graph, registry, { pageSize: 2 });
    await assert.rejects(ingest.ingest("one", { key: "films" }), /temporary/);
    assert.equal(graph.page({ sourceIds: ["one"] }).length, 2);
    assert.equal(graph.sql("SELECT cursor FROM IngestionJobs").get().cursor, "2");
    fail = false;
    assert.deepEqual(await ingest.ingest("one", { key: "films" }), { imported: 5, resumed: true });
    assert.deepEqual(cursors, [null, "2", "2", "4"]);
    assert.equal(graph.page({ sourceIds: ["one"] }).length, 5); assert.equal(resolved, 0);
  } finally { graph.close(); }
});
test("successful refresh hides removed catalogue records without changing synthetic IDs", async () => {
  const { graph, registry, source } = setup();
  try {
    let current = ["a", "b"];
    source("one", { catalog: async () => ({ items: current.map((id) => ({ type: "movie", title: id, sourceKey: id })), nextCursor: null }) }, { catalog: true, streams: false, types: ["movie"] });
    const ingest = new CatalogueIngestor(graph, registry);
    await ingest.ingest("one", { key: "films" });
    const id = graph.page({ sourceIds: ["one"] })[1].id;
    const synthetic = graph.synthetic("xtream", id);
    current = ["b"];
    await ingest.ingest("one", { key: "films" }, { refresh: true });
    assert.equal(graph.page({ sourceIds: ["one"] }).length, 1);
    assert.equal(graph.synthetic("xtream", id), synthetic);
  } finally { graph.close(); }
});

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { MediaEngine } = require("../core/engine");
const { contentId } = require("../sources/addon");
const secret = "test-canonical-source-engine-encryption-key";
test("Jellyfin read-only output maps scoped canonical metadata through the official SDK", async () => {
  const { createJellyfinOutput, itemId, canonicalId } = require("../protocols/jellyfin");
  const { OutputLibrary } = require("../protocols/library");
  const { Jellyfin } = await import("@jellyfin/sdk");
  const { getItemsApi } = await import("@jellyfin/sdk/lib/utils/api/items-api.js");
  const engine = new MediaEngine(":memory:", { secret });
  let server;
  try {
    for (const id of ["customer", "excluded"]) engine.graph.addSource({ id, protocol: "fixture", name: id, configuration: { password: "private-upstream" } });
    const [movie] = engine.graph.ingest("customer", [{ sourceKey: "movie", type: "movie", title: "Owned Film", year: 2026, runtimeSeconds: 90, externalIDs: { imdb: "tt1375666" }, genres: ["Comedy"], resolverData: { url: "https://private.example/movie" } }]);
    engine.graph.ingest("excluded", [{ sourceKey: "same", type: "movie", title: "Hidden provider title", externalIDs: { imdb: "tt1375666" } }, { sourceKey: "hidden", type: "movie", title: "Excluded film" }]);
    const [series] = engine.graph.ingest("customer", [{ sourceKey: "series", type: "series", title: "Owned Show", externalIDs: { imdb: "tt0903747" } }]);
    const [episode] = engine.graph.ingest("customer", [{ sourceKey: "episode", type: "episode", title: "Pilot", seriesId: series, seasonNumber: 1, episodeNumber: 1 }]);
    engine.graph.ingest("customer", [{ sourceKey: "second-season", type: "episode", title: "Return", seriesId: series, seasonNumber: 2, episodeNumber: 1 }]);
    const [channel] = engine.graph.ingest("customer", [{ sourceKey: "channel", type: "channel", title: "Owned Live", channel: { number: "12" } }]);
    const collection = engine.graph.createCollection({ name: "Customer", sourceIds: ["customer"] });
    const library = new OutputLibrary(engine, collection, {});
    const output = await createJellyfinOutput(library);
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://fixture");
        assert.equal(url.pathname, "/Items");
        assert.ok(req.headers.authorization.includes('Token="sdk-test"'));
        const data = await output.items({ startIndex: Number(url.searchParams.get("startIndex") || 0), limit: Number(url.searchParams.get("limit") || 100), includeItemTypes: url.searchParams.get("includeItemTypes")?.split(","), searchTerm: url.searchParams.get("searchTerm") || "", parentId: url.searchParams.get("parentId") || undefined, enableTotalRecordCount: url.searchParams.get("enableTotalRecordCount") !== "false" });
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data));
      } catch (error) { res.writeHead(error.status || 500); res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
    const sdk = new Jellyfin({ clientInfo: { name: "Boss output test", version: "1" }, deviceInfo: { name: "Test", id: "test" } });
    const api = getItemsApi(sdk.createApi(`http://127.0.0.1:${server.address().port}`, "sdk-test"));
    const data = (await api.getItems({ includeItemTypes: ["Movie"], limit: 1 })).data;
    assert.equal(data.Items.length, 1);
    assert.equal(data.TotalRecordCount, 1);
    assert.equal(data.Items[0].Name, "Owned Film");
    assert.equal(data.Items[0].Type, "Movie");
    assert.equal(data.Items[0].RunTimeTicks, 900000000);
    assert.equal(data.Items[0].ProviderIds.Imdb, "tt1375666");
    assert.equal(canonicalId(data.Items[0].Id), engine.graph.media(movie).canonicalId);
    assert.ok(!JSON.stringify(data).includes("private") && !JSON.stringify(data).includes("Hidden"));
    assert.equal((await api.getItems({ includeItemTypes: ["Movie"], startIndex: 1, limit: 1 })).data.Items.length, 0);
    assert.equal((await api.getItems({ includeItemTypes: ["Movie"], startIndex: 1, limit: 1 })).data.TotalRecordCount, 1);
    assert.equal((await api.getItems({ includeItemTypes: ["Movie"], enableTotalRecordCount: false })).data.TotalRecordCount, undefined);
    assert.equal((await api.getItems({ includeItemTypes: ["Movie"], searchTerm: "Excluded" })).data.Items.length, 0);
    const episodes = (await api.getItems({ includeItemTypes: ["Episode"], parentId: itemId(engine.graph.media(series)) })).data.Items;
    assert.equal(episodes.length, 2);
    assert.equal(episodes[0].Id, itemId(engine.graph.media(episode)));
    assert.equal(episodes[0].SeriesId, itemId(engine.graph.media(series)));
    assert.equal(episodes[0].ParentIndexNumber, 1);
    assert.equal(episodes[0].IndexNumber, 1);
    assert.ok(episodes[0].SeasonId);
    const seasons = (await api.getItems({ parentId: itemId(engine.graph.media(series)), limit: 1 })).data;
    assert.equal(seasons.TotalRecordCount, 2);
    assert.equal(seasons.Items.length, 1);
    assert.equal(seasons.Items[0].Type, "Season");
    const firstSeason = (await api.getItems({ parentId: episodes[0].SeasonId })).data;
    assert.equal(firstSeason.TotalRecordCount, 1);
    assert.deepEqual(firstSeason.Items.map(item => item.Id), [episodes[0].Id]);
    assert.equal((await api.getItems({ includeItemTypes: ["Episode"], parentId: episodes[0].SeasonId, searchTerm: "Return" })).data.TotalRecordCount, 0);
    assert.equal(library.count({ types: ["movie"], sourceIds: ["excluded"], limit: 1, offset: 100 }), 1, "Library count cannot override source scope");
    assert.equal(engine.graph.count({ sourceIds: [], types: ["movie"] }), 0);
    assert.equal(library.count({ search: "!!!" }), 0);
    assert.equal(library.count({ categoryId: -1 }), 0);
    assert.equal(output.record(engine.graph.media(channel)).Type, "TvChannel");
    assert.equal((await api.getItems({ includeItemTypes: ["TvChannel"] })).data.Items[0].Id, itemId(engine.graph.media(channel)));
    assert.equal(output.record(engine.graph.media(channel)).ChannelNumber, "12");
    await assert.rejects(output.items({ limit: 100000 }), { status: 400 });
    await assert.rejects(output.items({ includeItemTypes: ["Unknown"] }), { status: 422 });
    assert.throws(() => canonicalId("../../private"), { status: 400 });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await engine.close();
  }
});
test("addon feed names and declared genres become source-labelled Xtream categories", async () => {
  const { OutputLibrary } = require("../protocols/library");
  const { createXtreamOutput } = require("../protocols/xtream");
  const engine = new MediaEngine(":memory:", { secret });
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/manifest.json") return res.end(JSON.stringify({ id: "owned", types: ["movie", "series"], resources: ["catalog"], catalogs: [
      { id: "latest", type: "movie", name: "New Movies" }, { id: "shows", type: "series", name: "New Series" }
    ] }));
    const movie = req.url.includes("/movie/");
    res.end(JSON.stringify({ metas: [{ id: movie ? "tt1375666" : "tt0903747", type: movie ? "movie" : "series", name: movie ? "Owned Movie" : "Owned Series", genres: [movie ? "Comedy" : "Drama"] }] }));
  });
  const collect = async iterable => { let text = ""; for await (const part of iterable) text += part; return JSON.parse(text); };
  try {
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
    await engine.addSource({ id: "addon", protocol: "other", name: "My Addon", configuration: { baseUrl: `http://127.0.0.1:${server.address().port}` } });
    await engine.ingestSource("addon", { indexEpisodes: false });
    const collection = engine.graph.createCollection({ name: "Merged", sourceIds: ["addon"] });
    const library = new OutputLibrary(engine, collection, {});
    const output = createXtreamOutput(library, { server: "https://boss.example/xtream", username: "user", password: "secret" });
    for (const [kind, names, action] of [["vod", ["New Movies", "Comedy"], "get_vod_streams"], ["series", ["New Series", "Drama"], "get_series"]]) {
      const categories = await collect(output.render(new URLSearchParams({ action: `get_${kind}_categories` })));
      assert.deepEqual(categories.map(row => row.category_name), ["Boss Media", ...names.map(name => `My Addon | ${name}`)]);
      assert.equal((await collect(output.render(new URLSearchParams({ action })))).length, 1);
      for (const category of categories.slice(1)) {
        const rows = await collect(output.render(new URLSearchParams({ action, category_id: category.category_id })));
        assert.equal(rows.length, 1);
      }
    }
    assert.equal(library.page().length, 2, "Category membership must not duplicate canonical titles");
  } finally { await engine.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test("eight Xtream accounts merge through the graph with persistent IDs and customer isolation", async () => {
  const fs = require("node:fs/promises");
  const { OutputLibrary } = require("../protocols/library");
  const { createXtreamOutput } = require("../protocols/xtream");
  const { createBossOutput } = require("../protocols/boss");
  const { playlist } = require("../protocols/m3u");
  const dir = await fs.mkdtemp("/tmp/boss-eight-providers-");
  let engine = new MediaEngine(`${dir}/graph.sqlite`, { secret });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    const id = url.pathname.split("/")[1];
    res.setHeader("Content-Type", "application/json");
    if (!/^p[0-8]$/.test(id) || url.searchParams.get("username") !== `user-${id}` || url.searchParams.get("password") !== `private-${id}`) { res.writeHead(401); return res.end("{}"); }
    const action = url.searchParams.get("action");
    if (!action) return res.end(JSON.stringify({ user_info: { auth: 1, status: "Active" } }));
    if (action === "get_vod_streams") return res.end(JSON.stringify([
      { stream_id: 1, name: `Shared film ${id}`, imdb_id: "tt1375666", category_id: 1, category_name: `Genre ${id}`, container_extension: "mp4" },
      { stream_id: 2, name: `Exclusive ${id}`, imdb_id: `tt900000${id.slice(1)}`, category_id: 2, category_name: `Only ${id}`, container_extension: "mp4" }
    ]));
    res.end("[]");
  });
  const collect = async iterable => { let value = ""; for await (const chunk of iterable) value += chunk; return value; };
  const credentials = { server: "https://boss.example/xtream", username: "customer", password: "output-only" };
  const links = { play: media => `https://boss.example/play/${media.canonicalId}`, artwork: () => "", boss: "https://boss.example/addon.boss", epg: "https://boss.example/guide" };
  try {
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
    const sourceIds = Array.from({ length: 8 }, (_, i) => `p${i}`);
    for (const id of [...sourceIds, "p8"]) {
      await engine.addSource({ id, protocol: "xtream", name: id, configuration: { baseUrl: `http://127.0.0.1:${server.address().port}/${id}`, username: `user-${id}`, password: `private-${id}` } });
      await engine.ingestSource(id, { indexEpisodes: false });
    }
    let collection = engine.graph.createCollection({ name: "Eight providers", sourceIds });
    let library = new OutputLibrary(engine, collection, links);
    const common = library.page().find(media => media.externalIDs.imdb === "tt1375666");
    assert.equal(library.page().length, 9);
    assert.equal(engine.graph.mappings(common.id, sourceIds).length, 8);
    const originalId = engine.synthetic("xtream", common.id);
    const output = createXtreamOutput(library, credentials);
    const rows = JSON.parse(await collect(output.render(new URLSearchParams({ action: "get_vod_streams" }))));
    assert.equal(rows.length, 9);
    assert.equal(new Set(rows.map(row => row.stream_id)).size, 9);
    const categories = JSON.parse(await collect(output.render(new URLSearchParams({ action: "get_vod_categories" }))));
    assert.equal(categories.length, 17);
    assert.ok(!categories.some(category => category.category_name.includes("p8")));
    for (const id of sourceIds) {
      const category = categories.find(item => item.category_name === `Genre ${id}`);
      const matches = JSON.parse(await collect(output.render(new URLSearchParams({ action: "get_vod_streams", category_id: category.category_id }))));
      assert.equal(matches.length, 1);
      assert.equal(matches[0].stream_id, originalId);
    }
    const text = await collect(playlist(library, credentials));
    const urls = text.split("\n").filter(line => line && !line.startsWith("#"));
    assert.equal(urls.length, 9);
    assert.ok(urls.every(url => url.startsWith(`${credentials.server}/movie/customer/output-only/`)));
    assert.ok(!text.includes("private-") && !text.includes("127.0.0.1") && !text.includes("Exclusive p8"));
    const boss = await createBossOutput(library, "https://boss.example").catalogue(new URLSearchParams());
    assert.equal(boss.items.length, 9);
    const resolved = await library.resolve(common, { protocols: ["http"] });
    assert.deepEqual(resolved.candidates.map(item => item.sourceId).sort(), sourceIds);
    for (const candidate of resolved.candidates) {
      const parts = new URL(candidate.resource.url).pathname.split("/");
      assert.equal(parts[1], candidate.sourceId);
      assert.equal(parts[3], `user-${candidate.sourceId}`);
      assert.equal(parts[4], `private-${candidate.sourceId}`);
    }
    collection = engine.graph.updateCollection(collection.id, { name: collection.name, revision: collection.revision, sourceIds: sourceIds.slice(1) });
    assert.equal(library.page().length, 8);
    const remainingPlaylist = await collect(playlist(library, credentials));
    assert.ok(!remainingPlaylist.includes("Exclusive p0"));
    assert.deepEqual((await library.resolve(common, { protocols: ["http"] })).candidates.map(item => item.sourceId).sort(), sourceIds.slice(1));
    const outsider = engine.graph.page({ sourceIds: ["p8"] }).find(media => media.title === "Exclusive p8");
    assert.throws(() => library.media(outsider.canonicalId), { status: 404 });
    await engine.close();
    engine = new MediaEngine(`${dir}/graph.sqlite`, { secret });
    library = new OutputLibrary(engine, engine.graph.collection(collection.id), links);
    assert.equal(library.synthetic(originalId).canonicalId, common.canonicalId);
    assert.equal(library.page().length, 8);
    assert.equal(engine.graph.collection(collection.id).sourceIds.length, 7);
  } finally {
    await engine.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("Cinemeta moviedb identities join IMDb and TMDB records without title guessing", async () => {
  const { normalizeMetadata } = require("../sources/addon");
  const engine = new MediaEngine(":memory:", { secret });
  try {
    engine.graph.addSource({ id: "catalogue", protocol: "catalogue", name: "Metadata", configuration: {} });
    engine.graph.addSource({ id: "server", protocol: "xtream", name: "Server", configuration: {} });
    const [first] = engine.graph.ingest("catalogue", [{ sourceKey: "tt1375666", type: "movie", title: "Inception", externalIDs: { imdb: "tt1375666" } }]);
    const [second] = engine.graph.ingest("server", [{ sourceKey: "27205", type: "movie", title: "EN- Inception", externalIDs: { tmdb: "27205" } }]);
    const oldOutputId = engine.graph.synthetic("xtream", second);
    const [other] = engine.graph.ingest("catalogue", [{ sourceKey: "tt5581256", type: "movie", title: "Inception", externalIDs: { imdb: "tt5581256" } }]);
    engine.graph.ingest("catalogue", [normalizeMetadata({ id: "tt1375666", type: "movie", name: "Inception", moviedb_id: 27205 }, "movie")]);
    assert.equal(engine.graph.media(second).id, first);
    assert.equal(engine.graph.fromSynthetic("xtream", oldOutputId).id, first);
    assert.equal(engine.graph.media(other).id, other);
  } finally { await engine.close(); }
});
test("metadata sources accept long year lists and omit personalized feeds without inventing genres", async () => {
  const { createAddonSource } = require("../sources/addon");
  const years = Array.from({ length: 107 }, (_, index) => String(2026 - index));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url); res.setHeader("Content-Type", "application/json");
    if (req.url === "/manifest.json") return res.end(JSON.stringify({ id: "year-test", types: ["movie", "series"], resources: ["catalog", "meta"], catalogs: [
      { id: "year", type: "movie", extra: [{ name: "genre", isRequired: true, options: years }, { name: "skip" }] },
      { id: "personal", type: "series", extra: [{ name: "watchedIds", isRequired: true }] }
    ] }));
    if (req.url.startsWith("/catalog/")) { res.writeHead(307, { Location: "/year-results" }); return res.end(); }
    res.end(JSON.stringify({ metas: [{ id: "tt1375666", name: "Owned metadata", type: "movie", releaseInfo: "2026" }] }));
  });
  try {
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
    const source = { id: "metadata", protocol: "catalogue", configuration: { baseUrl: `http://127.0.0.1:${server.address().port}/manifest.json` } };
    const adapter = await createAddonSource(source);
    assert.equal(adapter.catalogs.length, 107);
    assert.equal(adapter.omittedCatalogs, 1);
    assert.equal(adapter.capabilities.search, false);
    const first = await adapter.catalog({ key: adapter.catalogs[0].key, limit: 200 });
    assert.equal(first.items[0].year, 2026);
    assert.ok(!first.items[0].genres?.includes("2026"));
    assert.equal(first.items[0].categories[0].key, "year:2026");
    assert.ok(requests.some(path => path.includes("genre=2026")));
    assert.equal(requests.at(-1), "/year-results");
    assert.ok(!requests.some(path => path.includes("/stream/")));
    await assert.rejects(createAddonSource({ ...source, protocol: "other" }), /64 preset options/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test("Cinemeta fills missing series episodes without resolving playback or replacing source identities", async () => {
  const { createAddonSource } = require("../sources/addon");
  const { cinematographicMetadata } = require("../sources/cinemeta");
  let base, streams = 0, ambiguous = false, episodeMetadataRequests = 0;
  const previous = process.env.BOSS_CINEMETA_URL;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.setHeader("Content-Type", "application/json");
    const pathname = decodeURIComponent(new URL(req.url, "http://fixture").pathname);
    if (pathname.startsWith("/meta/") && pathname.includes("tt0903747:")) episodeMetadataRequests++;
    if (pathname === "/manifest.json") return res.end(JSON.stringify({ id: "test.metadata", types: ["series"], resources: ["meta", "stream"], catalogs: [] }));
    if (pathname.startsWith("/catalog/")) return res.end(JSON.stringify({ metas: [{ id: "tt0903747", name: "Breaking Bad", releaseInfo: "2008-2013" }, ...(ambiguous ? [{ id: "tt1234567", name: "Breaking Bad", releaseInfo: "2008" }] : [])] }));
    if (pathname === "/meta/series/localshow.json") return res.end(JSON.stringify({ meta: { id: "localshow", type: "series", name: "Breaking Bad (2008)", releaseInfo: "2008", videos: [] } }));
    if (pathname === "/meta/series/tt0903747.json") return res.end(JSON.stringify({ meta: { id: "tt0903747", type: "series", name: "Breaking Bad", releaseInfo: "2008", videos: [{ id: "tt0903747:1:1", season: 1, episode: 1, title: "Pilot" }] } }));
    if (pathname === "/stream/series/tt0903747:1:1.json") { streams++; return res.end(JSON.stringify({ streams: [{ url: `${base}/owned.mp4` }] })); }
    res.writeHead(404); res.end("{}");
  });
  try {
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    process.env.BOSS_CINEMETA_URL = base;
    const adapter = await createAddonSource({ id: "fixture", configuration: { baseUrl: base } });
    const mapping = { sourceKey: "localshow", sourceType: "series" };
    const metadata = await adapter.metadata(mapping, { media: { id: 10, type: "series", title: "Breaking Bad (2008)", year: 2008 } });
    assert.equal(metadata.sourceKey, "localshow");
    assert.equal(metadata.externalIDs.imdb, "tt0903747");
    assert.equal(metadata.children[0].sourceKey, "tt0903747:1:1");
    assert.equal(metadata.children[0].seriesId, 10);
    assert.equal(streams, 0);
    assert.equal((await adapter.resolve(metadata.children[0], { sourceKey: metadata.children[0].sourceKey, sourceType: "series" }, {})).length, 1);
    assert.equal(streams, 1);
    const engine = new MediaEngine(":memory:", { secret });
    try {
      engine.graph.addSource({ id: "fixture", protocol: "fixture", name: "Fixture", configuration: {}, capabilities: adapter.capabilities });
      engine.registry.get = async () => adapter;
      const [seriesId] = engine.graph.ingest("fixture", [{ sourceKey: "localshow", sourceType: "series", type: "series", title: "Breaking Bad", year: 2008 }]);
      await engine.metadata(seriesId, { allowedSourceIds: ["fixture"] });
      const [episode] = engine.graph.page({ sourceIds: ["fixture"], types: ["episode"] });
      const collection = engine.graph.createCollection({ name: "SDK", sourceIds: ["fixture"] });
      const { OutputLibrary } = require("../protocols/library");
      const { createBossOutput } = require("../protocols/boss");
      const output = createBossOutput(new OutputLibrary(engine, collection, {}), base);
      const result = await output.media(episode.canonicalId);
      assert.equal(result.media.title, "Pilot");
      assert.equal(result.media.seasonNumber, 1);
      assert.equal(result.media.episodeNumber, 1);
      assert.equal(episodeMetadataRequests, 0);
      assert.equal(streams, 1, "Reading episode metadata must not resolve playback");
    } finally { await engine.close(); }
    ambiguous = true;
    assert.equal(await cinematographicMetadata({ type: "series", title: "Breaking Bad", year: 2008 }, { baseUrl: base }), null);
  } finally {
    if (previous === undefined) delete process.env.BOSS_CINEMETA_URL; else process.env.BOSS_CINEMETA_URL = previous;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
test("metadata deadlines release capacity, fall back and discard late adapter results", async () => {
  const engine = new MediaEngine(":memory:", { secret });
  let late, stalledSignal;
  try {
    for (const id of ["a-stalled", "b-healthy"]) {
      engine.graph.addSource({ id, protocol: "fixture", name: id, configuration: {} });
      engine.graph.ingest(id, [{ sourceKey: "film", type: "movie", title: "Film", externalIDs: { imdb: "tt1375666" } }]);
    }
    engine.registry.get = async (id) => ({ capabilities: { metadata: true }, metadata: async (_mapping, { signal }) => {
      if (id === "a-stalled") { stalledSignal = signal; return new Promise((resolve) => { late = resolve; }); }
      return { sourceKey: "film", type: "movie", title: "Healthy metadata", externalIDs: { imdb: "tt1375666" } };
    } });
    const media = engine.graph.page({ sourceIds: ["a-stalled"] })[0];
    const result = await engine.hydrate(media, engine.graph.mappings(media.id, ["a-stalled", "b-healthy"]));
    assert.equal(result.title, "Healthy metadata");
    assert.equal(stalledSignal.aborted, true);
    assert.equal(engine.resolver.limiter.active, 0);
    late({ sourceKey: "film", type: "movie", title: "Late response must not overwrite" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(engine.graph.media(media.id).title, "Healthy metadata");
    const stopped = engine.hydrate(media, engine.graph.mappings(media.id, ["a-stalled"]));
    await new Promise((resolve) => setImmediate(resolve));
    engine.shutdown.abort(new Error("Test shutdown"));
    await assert.rejects(stopped, /Test shutdown/);
    assert.equal(engine.resolver.limiter.active, 0);
  } finally { late?.(null); await engine.close(); }
});
test("daily metadata scans pause historical backfill and preserve imported titles", async () => {
  const engine = new MediaEngine(":memory:", { secret });
  const year = new Date(engine.graph.clock()).getUTCFullYear();
  const calls = []; let empty = false;
  const catalog = value => ({ key: String(value), enumerable: true, fixedExtras: { genre: String(value) } });
  const adapter = { capabilities: { catalog: true, types: ["movie"] }, catalogs: [catalog(year), catalog(year - 1), catalog(year - 20), catalog(year + 1)],
    async catalog({ key }) { calls.push(key); return { items: empty ? [] : [{ type: "movie", title: `Release ${key}`, sourceKey: key }], nextCursor: null }; }
  };
  try {
    engine.graph.addSource({ id: "metadata", protocol: "catalogue", name: "Metadata", configuration: {} });
    engine.registry.get = async () => adapter;
    await engine.ingestor.ingest("metadata", catalog(year - 20));
    engine.graph.sql("INSERT INTO SourceCatalogs VALUES(?,?)").run("metadata", String(year - 20));
    engine.graph.sql("UPDATE IngestionJobs SET status='running' WHERE source_id='metadata'").run();
    calls.length = 0;
    await engine.runSource("metadata");
    assert.deepEqual(calls, [String(year), String(year - 1)]);
    assert.equal(engine.graph.sql("SELECT error_code FROM IngestionJobs WHERE catalog_key=?").get(String(year - 20)).error_code, "CATALOGUE_PAUSED");
    assert.equal(engine.page({ sourceIds: ["metadata"] }).length, 3);
    empty = true; calls.length = 0;
    await engine.runSource("metadata", { refresh: true });
    assert.deepEqual(calls, [String(year), String(year - 1)]);
    assert.equal(engine.page({ sourceIds: ["metadata"] }).length, 3, "Missing release-feed entries remain discoverable");
    assert.equal(engine.graph.sql("SELECT count(*) n FROM SourceCatalogs").get().n, 3);
  } finally { await engine.close(); }
});

test("root catalogue failures preserve progress, run later feeds and resume only incomplete jobs", async () => {
  const engine = new MediaEngine(":memory:", { secret });
  let failure = new Error("private upstream URL"), guides = 0;
  const calls = [];
  const adapter = {
    capabilities: { catalog: true, epg: true, types: ["movie"] },
    catalogs: ["broken", "healthy", "later"].map(key => ({ key, enumerable: true })),
    async catalog({ key }) {
      calls.push(key);
      if (key === "broken" && failure) throw failure;
      return { items: [{ type: "movie", title: key, sourceKey: key }], nextCursor: null };
    },
    async *epg() { guides++; }
  };
  try {
    engine.graph.addSource({ id: "fixture", protocol: "fixture", name: "Fixture", configuration: {} });
    engine.registry.get = async () => adapter;
    await assert.rejects(engine.runSource("fixture"), error => error.code === "CATALOGUE_SYNC_PARTIAL" && error.failedCatalogs === 1 && !error.message.includes("private"));
    assert.deepEqual(calls, ["broken", "healthy", "later"]);
    assert.equal(guides, 1);
    assert.equal(engine.graph.sql("SELECT count(*) n FROM MediaItems").get().n, 2);
    assert.equal(engine.graph.sql("SELECT error_code FROM SourceSync").get().error_code, "CATALOGUE_SYNC_PARTIAL");
    failure = null; calls.length = 0;
    await engine.runSource("fixture");
    assert.deepEqual(calls, ["broken"]);
    assert.equal(engine.graph.sql("SELECT status FROM SourceSync").get().status, "complete");
    for (const upstreamStatus of [401, 403, 429]) {
      calls.length = 0;
      failure = Object.assign(new Error("Unavailable"), { upstreamStatus, retryAfter: 90 });
      await assert.rejects(engine.runSource("fixture", { refresh: true }), error => error === failure);
      assert.deepEqual(calls, ["broken"]);
    }
  } finally { await engine.close(); }
});
test("addon catalogue requests preserve deadlines with a caller signal and expose rate limits safely", async () => {
  const { createAddonSource } = require("../sources/addon");
  let mode = "rate";
  const server = http.createServer((req, res) => {
    if (req.url === "/manifest.json") return res.end(JSON.stringify({ id: "deadline-fixture", types: ["movie"], resources: ["catalog"], catalogs: [{ id: "all", type: "movie" }] }));
    if (mode === "rate") { res.writeHead(429, { "Retry-After": "120" }); return res.end("private response body"); }
  });
  try {
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
    const adapter = await createAddonSource({ id: "fixture", configuration: { baseUrl: `http://127.0.0.1:${server.address().port}` } });
    const request = { key: adapter.catalogs[0].key, limit: 200, signal: new AbortController().signal };
    await assert.rejects(adapter.catalog(request), error => error.upstreamStatus === 429 && error.retryAfter === 120 && !error.message.includes("private"));
    mode = "hang";
    const started = Date.now();
    await assert.rejects(adapter.catalog(request), error => error.name === "TimeoutError");
    assert.ok(Date.now() - started < 20000);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(adapter.catalog({ ...request, signal: controller.signal }), error => error.name === "AbortError");
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("episode indexing isolates unavailable series, runs guides and retries only missing checkpoints", async () => {
  const engine = new MediaEngine(":memory:", { secret });
  let unavailable = true, guides = 0;
  const calls = [];
  const adapter = {
    catalogs: [], capabilities: { metadata: true, epg: true, types: ["series"] },
    async metadata(mapping) {
      calls.push(mapping.sourceKey);
      if (unavailable && mapping.sourceKey === "broken") throw new Error("Upstream failure with private details");
      return { sourceKey: mapping.sourceKey, type: "series", title: mapping.sourceKey, children: [] };
    },
    async *epg() { guides++; }
  };
  try {
    engine.graph.addSource({ id: "fixture", protocol: "fixture", name: "Fixture", configuration: {} });
    engine.graph.ingest("fixture", ["broken", "healthy", "later"].map((sourceKey) => ({ type: "series", sourceKey, title: sourceKey })));
    engine.registry.get = async () => adapter;
    await assert.rejects(engine.runSource("fixture"), (error) => error.code === "EPISODE_SYNC_PARTIAL" && error.failedSeries === 1 && !error.message.includes("private"));
    assert.deepEqual(calls, ["broken", "healthy", "later"]);
    assert.equal(guides, 1);
    assert.equal(engine.graph.sql("SELECT count(*) AS n FROM SeriesHydration").get().n, 2);
    assert.equal(engine.graph.sql("SELECT error_code FROM SourceSync WHERE source_id='fixture'").get().error_code, "EPISODE_SYNC_PARTIAL");
    calls.length = 0; unavailable = false;
    await engine.runSource("fixture");
    assert.deepEqual(calls, ["broken"]);
    assert.equal(guides, 2);
    assert.equal(engine.graph.sql("SELECT count(*) AS n FROM SeriesHydration").get().n, 3);
    assert.equal(engine.graph.sql("SELECT status FROM SourceSync WHERE source_id='fixture'").get().status, "complete");
    engine.hydrate = async () => { engine.graph.sql("UPDATE Sources SET revision=revision+1 WHERE id='fixture'").run(); throw new Error("Source changed"); };
    await assert.rejects(engine.indexEpisodes("fixture", true), /Source changed during episode indexing/);
  } finally { await engine.close(); }
});
test("category provenance retires changed and removed feeds without erasing other sources", async () => {
  const engine = new MediaEngine(":memory:", { secret });
  let feeds = { action: ["Action"], popular: ["Popular", "Action"] };
  let failing = false;
  const adapter = {
    capabilities: { catalog: true, types: ["movie"] },
    get catalogs() { return Object.keys(feeds).map(key => ({ key, enumerable: true })); },
    async catalog({ key }) {
      if (failing && key === "popular") throw new Error("Unavailable");
      return { items: [{ type: "movie", title: "Film", sourceKey: "film", externalIDs: { imdb: "tt1375666" }, categories: feeds[key].map(name => ({ key: name, name })) }], nextCursor: null };
    }
  };
  const names = () => engine.graph.sql("SELECT DISTINCT c.name FROM MediaCategories mc JOIN Categories c ON c.id=mc.category_id ORDER BY c.name").all().map(row => row.name);
  try {
    for (const id of ["fixture", "other"]) engine.graph.addSource({ id, protocol: "fixture", name: id, configuration: {} });
    engine.graph.ingest("other", [{ type: "movie", title: "Film", sourceKey: "film", externalIDs: { imdb: "tt1375666" }, categories: [{ key: "Drama", name: "Drama" }] }]);
    engine.registry.get = async () => adapter;
    await engine.runSource("fixture");
    assert.deepEqual(names(), ["Action", "Drama", "Popular"]);
    feeds.action = ["Thriller"];
    await engine.runSource("fixture", { refresh: true });
    assert.deepEqual(names(), ["Action", "Drama", "Popular", "Thriller"]);
    feeds.action = []; failing = true;
    await assert.rejects(engine.runSource("fixture", { refresh: true }), { code: "CATALOGUE_SYNC_PARTIAL" });
    assert.deepEqual(names(), ["Action", "Drama", "Popular"]);
    feeds = { action: [] }; failing = false;
    await engine.runSource("fixture", { refresh: true });
    assert.deepEqual(names(), ["Drama"]);
    assert.equal(engine.graph.sql("SELECT count(*) n FROM MediaItems WHERE merged_into IS NULL").get().n, 1);
  } finally { await engine.close(); }
});

test("library metadata excludes unrelated sources and combines only current authorized genres", async () => {
  const { OutputLibrary } = require("../protocols/library");
  const { createBossOutput } = require("../protocols/boss");
  const engine = new MediaEngine(":memory:", { secret });
  try {
    for (const [id, priority] of [["first", 2], ["second", 1], ["private", 99]]) engine.graph.addSource({ id, priority, protocol: "fixture", name: id, configuration: {}, capabilities: { catalog: true, types: ["movie"] } });
    const put = (id, title, genres, extra = {}) => engine.graph.ingest(id, [{ type: "movie", sourceKey: "film", title, genres, externalIDs: { imdb: "tt1375666" }, ...extra }])[0];
    const id = put("first", "Library title", ["Action"], { description: "Library description" });
    put("second", "Alternative title", ["action", "Drama"]);
    put("private", "Private title", ["Private genre"], { description: "Private notes", certification: "Private label" });
    const collection = engine.graph.createCollection({ name: "Selected sources", sourceIds: ["first", "second"] });
    const library = new OutputLibrary(engine, collection, { artwork: () => "" });
    const output = createBossOutput(library, "https://boss.example/library");
    assert.equal(engine.graph.media(id).title, "Private title");
    const page = await output.catalogue(new URLSearchParams());
    assert.equal(page.items[0].title, "Library title");
    assert.equal(page.items[0].description, "Library description");
    assert.deepEqual(page.items[0].genres, ["Action", "Drama"]);
    assert.ok(!JSON.stringify(page).includes("Private"));
    engine.metadata = async () => engine.graph.media(id);
    assert.equal((await library.metadata(library.media(id))).title, "Library title");
    assert.equal(library.synthetic(engine.graph.synthetic("xtream", id)).title, "Library title");
    put("first", "Updated title", ["Comedy"]);
    assert.deepEqual(library.media(id).genres, ["Comedy", "action", "Drama"]);
    engine.graph.sql("UPDATE SourceMappings SET active=0 WHERE source_id='second'").run();
    assert.deepEqual(library.media(id).genres, ["Comedy"]);
    engine.graph.sql("UPDATE Sources SET enabled=0 WHERE id='first'").run();
    assert.throws(() => library.media(id), error => error.status === 404);
  } finally { await engine.close(); }
});

test("author categories work through native and M3U SDK discovery with validation", async () => {
  const { createBossAddon } = await import("../public/boss-addon.mjs");
  const { BossClient } = await import("../public/boss-client.mjs");
  let addon, base, invalid = false, selected;
  const server = http.createServer((req, res) => {
    if (req.url === "/playlist") return res.end(`#EXTM3U boss-addon-url="${base}/addon.boss"\n`);
    addon.emit("request", req, res);
  });
  try {
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const group = { id: "comedy", name: "Comedy", type: "movie" };
    addon = createBossAddon({ id: "categories", name: "Categories", types: ["movie"], baseUrl: base }, {
      categories: async () => ({ categories: invalid ? [group, group] : [group], next: null }),
      catalogue: async ({ categoryId }) => { selected = categoryId; return { items: [{ id: "film", type: "movie", title: "Film", category: group }], next: null }; }
    });
    for (const client of [await BossClient.fromAddon(`${base}/addon.boss`), await BossClient.fromM3u(`${base}/playlist`)]) {
      assert.deepEqual(await client.categories({ type: "movie" }), { categories: [group], next: null });
      assert.equal((await client.catalogue({ type: "movie", categoryId: "comedy" })).items[0].category.id, "comedy");
      assert.equal(selected, "comedy");
      await assert.rejects(client.categories({ type: "episode" }), error => error.status === 400);
      await assert.rejects(client.catalogue({ categoryId: "" }), error => error.status === 400);
    }
    invalid = true;
    const response = await fetch(`${base}/categories?type=movie`);
    assert.equal(response.status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("Boss source retains every category membership and retires removed feeds without changing identity", async () => {
  const { createBossAddon } = await import("../public/boss-addon.mjs");
  const { OutputLibrary } = require("../protocols/library");
  const { createBossOutput } = require("../protocols/boss");
  const { createXtreamOutput } = require("../protocols/xtream");
  const engine = new MediaEngine(":memory:", { secret });
  let addon, plays = 0, groups = ["Action", "Drama"];
  const server = http.createServer((req, res) => addon.emit("request", req, res));
  try {
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const category = name => ({ id: name, name, type: "movie" });
    addon = createBossAddon({ id: "multi", name: "Multi", baseUrl: base, types: ["movie"], token: "test-category-token" }, {
      categories: async ({ after }) => {
        const index = Number(after || 0);
        return { categories: groups.slice(index, index + 1).map(category), next: index + 1 < groups.length ? String(index + 1) : null };
      },
      catalogue: async ({ categoryId }) => ({ items: [{ id: "film", type: "movie", title: "Shared film", identities: { imdb: "tt1375666" }, category: category(categoryId || groups[0]) }], next: null }),
      playback: async () => { plays++; return []; }
    });
    await engine.addSource({ id: "native", protocol: "boss", name: "Native", configuration: { baseUrl: base, apiKey: "test-category-token" } });
    await engine.ingestSource("native");
    const library = new OutputLibrary(engine, engine.graph.createCollection({ name: "Merged", sourceIds: ["native"] }), { artwork: () => "" });
    const output = createBossOutput(library, "https://boss.example");
    const before = output.categories(new URLSearchParams({ type: "movie" })).categories;
    assert.deepEqual(before.map(row => row.name), ["Boss Media", "Native | Action", "Native | Drama"]);
    const canonical = (await output.catalogue(new URLSearchParams())).items[0].id;
    for (const entry of before.slice(1)) {
      const page = await output.catalogue(new URLSearchParams({ categoryId: entry.id }));
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0].id, canonical);
    }
    const xtream = createXtreamOutput(library, { server: "https://boss.example", username: "test", password: "test" });
    let body = "";
    for await (const chunk of xtream.render(new URLSearchParams({ action: "get_vod_categories" }))) body += chunk;
    assert.deepEqual(JSON.parse(body).map(row => row.category_name), before.map(row => row.name));
    let playlist = "";
    for await (const chunk of require("../protocols/m3u").playlist(library, { server: "https://boss.example", username: "test", password: "test" })) playlist += chunk;
    assert.match(playlist, /group-title="Native \| Action"/);
    groups = ["Drama"];
    await engine.ingestSource("native", { refresh: true });
    assert.deepEqual(output.categories(new URLSearchParams({ type: "movie" })).categories.map(row => row.name), ["Boss Media", "Native | Drama"]);
    assert.equal((await output.catalogue(new URLSearchParams())).items[0].id, canonical);
    assert.equal(plays, 0);
  } finally { await engine.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("Boss source rejects repeated category cursors and cross-origin discovery without forwarding its token", async () => {
  const { createBossSource } = require("../sources/boss");
  let base, mode = "repeat", calls = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer category-test");
    if (req.url === "/addon") return reply(res, { format: "boss-media-addon", version: 1, name: "Test", capabilities: { categories: true, types: ["movie"] }, resources: { catalogue: `${base}/catalogue`, categories: mode === "foreign" ? "https://foreign.invalid/categories" : `${base}/categories` } });
    calls++;
    reply(res, { categories: [], next: "again" });
  });
  try {
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const input = { id: "test", configuration: { baseUrl: base, apiKey: "category-test" } };
    await assert.rejects(createBossSource(input), /Invalid Boss category cursor/);
    assert.equal(calls, 2);
    mode = "foreign";
    await assert.rejects(createBossSource(input), /outside the configured source/);
    assert.equal(calls, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("Boss categories paginate, filter merged membership and omit unrelated or inactive sources", async () => {
  const { OutputLibrary } = require("../protocols/library");
  const { createBossOutput } = require("../protocols/boss");
  const engine = new MediaEngine(":memory:", { secret });
  try {
    for (const id of ["first", "second", "private"]) engine.graph.addSource({ id, protocol: "other", name: id, configuration: {}, capabilities: { types: ["movie"] } });
    const put = (source, names) => engine.graph.ingest(source, [{ sourceKey: "film", type: "movie", title: "Shared film", externalIDs: { imdb: "tt1375666" }, categories: names.map(name => ({ key: name, name })) }]);
    put("first", ["Action", "Comedy"]); put("second", ["Drama"]); put("private", ["Private"]);
    engine.graph.ingest("first", [{ sourceKey: "bare", type: "movie", title: "Uncategorized" }]);
    const collection = engine.graph.createCollection({ name: "Combined", sourceIds: ["first", "second"] });
    const library = new OutputLibrary(engine, collection, { artwork: () => "" });
    const output = createBossOutput(library, "https://boss.example/library");
    assert.equal(output.descriptor().capabilities.categories, true);
    assert.ok(output.descriptor().resources.categories.endsWith("/boss/categories"));
    const categories = []; let after = "0";
    do {
      const page = output.categories(new URLSearchParams({ type: "movie", after, limit: "1" }));
      assert.equal(page.categories.length, 1);
      categories.push(...page.categories); after = page.next;
    } while (after);
    assert.deepEqual(categories.map(row => row.name), ["Boss Media", "first | Action", "first | Comedy", "second | Drama"]);
    for (const category of categories) {
      const page = await output.catalogue(new URLSearchParams({ type: "movie", categoryId: category.id }));
      assert.equal(page.items.length, 1);
      assert.deepEqual(page.items[0].category, category);
      assert.equal(page.items[0].title, category.id === "1" ? "Uncategorized" : "Shared film");
    }
    for (const bad of ["0", "-1", "2.5", "oops", "9007199254740992"])
      await assert.rejects(output.catalogue(new URLSearchParams({ categoryId: bad })), error => error.status === 400);
    assert.throws(() => output.categories(new URLSearchParams()), error => error.status === 400);
    const privateId = String(engine.graph.sql("SELECT id FROM Categories WHERE source_id='private'").get().id + 1);
    assert.deepEqual((await output.catalogue(new URLSearchParams({ categoryId: privateId }))).items, []);
    engine.graph.sql("UPDATE SourceMappings SET active=0 WHERE source_id='first' AND source_key='film'").run();
    engine.graph.revision++;
    const film = (await output.catalogue(new URLSearchParams())).items.find(row => row.title === "Shared film");
    assert.equal(film.category.name, "second | Drama");
    assert.deepEqual(output.categories(new URLSearchParams({ type: "movie" })).categories.map(row => row.name), ["Boss Media", "second | Drama"]);
    let plan;
    const graph = { sql(query) { return { get(params) {
      plan = engine.graph.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(params);
      return engine.graph.sql(query).get(params);
    } }; } };
    require("../protocols/categories").primaryCategory({ graph, collection: library.collection }, library.media(film.id));
    assert.ok(plan.some(row => /SEARCH mc .*\(media_id=\?\)/.test(row.detail)), JSON.stringify(plan));
    assert.ok(!plan.some(row => /SCAN mc\b/.test(row.detail)), JSON.stringify(plan));
  } finally { await engine.close(); }
});

test("Xtream genre filters include every active category of a merged title", async () => {
  const { OutputLibrary } = require("../protocols/library");
  const { createXtreamOutput } = require("../protocols/xtream");
  const engine = new MediaEngine(":memory:", { secret });
  try {
    for (const id of ["first", "second", "private"]) engine.graph.addSource({ id, protocol: "fixture", name: id, configuration: {} });
    const put = (source, categories) => engine.graph.ingest(source, [{ sourceKey: source, type: "movie", title: "Shared film", externalIDs: { imdb: "tt1375666" }, categories: categories.map((name) => ({ key: name, name })) }]);
    put("first", ["Action", "Thriller"]); put("second", ["Drama"]); put("private", ["Private"]);
    engine.graph.ingest("first", [{ sourceKey: "uncategorized", type: "movie", title: "No category", resolverData: { extension: "mkv" } }]);
    const collection = engine.graph.createCollection({ name: "Combined", sourceIds: ["first", "second"] });
    const library = new OutputLibrary(engine, collection, { artwork: () => "" });
    const output = createXtreamOutput(library, { server: "https://boss.example", username: "test", password: "test" });
    const request = async (params) => { let body = ""; for await (const part of output.render(new URLSearchParams(params))) body += part; return JSON.parse(body); };
    const categories = await request({ action: "get_vod_categories" });
    assert.deepEqual(categories.map((row) => row.category_name), ["Boss Media", "Action", "Thriller", "Drama"]);
    const defaultRows = await request({ action: "get_vod_streams", category_id: "1" });
    assert.deepEqual(defaultRows.map((row) => row.name), ["No category"]);
    assert.equal(defaultRows[0].container_extension, "mkv");
    assert.ok(defaultRows[0].direct_source.endsWith(".mkv"));
    const privateId = engine.graph.sql("SELECT id FROM Categories WHERE source_id='private'").get().id + 1;
    for (const category of [String(privateId), "-1", "garbage", "2.5", "99999999999999999999"]) assert.deepEqual(await request({ action: "get_vod_streams", category_id: category }), []);
    let stable;
    for (const category of categories.slice(1)) {
      const rows = await request({ action: "get_vod_streams", category_id: category.category_id });
      assert.equal(rows.length, 1, category.category_name);
      assert.equal(rows[0].category_id, category.category_id);
      stable ??= rows[0].stream_id;
      assert.equal(rows[0].stream_id, stable);
    }
    engine.graph.sql("UPDATE SourceMappings SET active=0 WHERE source_id='first'").run();
    engine.graph.revision++;
    assert.deepEqual((await request({ action: "get_vod_categories" })).map((row) => row.category_name), ["Boss Media", "Drama"]);
    assert.equal((await request({ action: "get_vod_streams", category_id: categories[1].category_id })).length, 0);
    const remaining = await request({ action: "get_vod_streams", category_id: categories[3].category_id });
    assert.equal(remaining[0].stream_id, stable);
    assert.equal(remaining[0].category_id, categories[3].category_id);
  } finally { await engine.close(); }
});
test("guide refresh publishes atomically, retires removed upcoming events and retains recent history", async () => {
  const engine = new MediaEngine(":memory:", { secret });
  const now = Date.now();
  const event = (key, endsAt = now + 3600000) => ({ sourceKey: key, channelKey: "guide", title: key, startsAt: endsAt - 1800000, endsAt });
  const adapter = (events) => ({ async *epg() { yield* events; } });
  const rows = () => engine.graph.sql("SELECT source_key,title,id FROM EPGEvents ORDER BY source_key").all();
  try {
    engine.graph.addSource({ id: "source", protocol: "fixture", name: "Guide", configuration: {} });
    engine.graph.ingest("source", [{ sourceKey: "channel", type: "channel", title: "Channel", channel: { epgId: "guide" } }]);
    await engine.ingestEpg("source", adapter([event("stable"), event("removed"), event("history", now - 86400000), event("expired", now - 31 * 86400000)]));
    const before = rows(); assert.equal(before.length, 3);
    await assert.rejects(engine.ingestEpg("source", { async *epg() {
      for (let index = 0; index < 201; index++) yield event(`partial-${index}`);
      assert.deepEqual(rows(), before, "Staged batches must not appear in live guide queries");
      throw new Error("Truncated guide download");
    } }), /Truncated guide/);
    assert.deepEqual(rows(), before);
    assert.equal(engine.graph.sql("SELECT count(*) n FROM GuideStage").get().n, 0);
    await engine.ingestEpg("source", adapter([{ ...event("stable"), title: "Updated title" }, event("new")]));
    assert.deepEqual(rows().map((row) => row.source_key), ["history", "new", "stable"]);
    assert.equal(rows().find((row) => row.source_key === "stable").id, before.find((row) => row.source_key === "stable").id);
    const published = rows();
    await assert.rejects(engine.ingestEpg("source", { async *epg() {
      yield event("obsolete-revision"); engine.graph.updateSource("source", { configuration: { changed: true } });
    } }), /changed during refresh/);
    assert.deepEqual(rows(), published);
    await engine.ingestEpg("source", adapter([]));
    assert.deepEqual(rows().map((row) => row.source_key), ["history"]);
  } finally { await engine.close(); }
});
test("app SDK bounds streamed metadata and preserves body-download cancellation", async () => {
  const { BossClient } = await import("../public/boss-client.mjs");
  let interrupted;
  const streaming = new Promise((resolve) => { interrupted = resolve; });
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/declared") { res.setHeader("Content-Length", 9 * 1024 * 1024); res.write("{"); return; }
    if (req.url === "/chunked") { res.write('{"padding":"'); return res.end(Buffer.alloc(9 * 1024 * 1024, 120)); }
    if (req.url === "/cancel") { res.write('{"padding":"'); interrupted(); return; }
    res.end(req.url === "/null" ? "null" : "{malformed");
  });
  try {
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const suffix of ["declared", "chunked"]) await assert.rejects(BossClient.fromAddon(`${base}/${suffix}`), (error) => error.status === 413);
    for (const suffix of ["null", "invalid"]) await assert.rejects(BossClient.fromAddon(`${base}/${suffix}`), /Invalid Boss response/);
    const controller = new AbortController();
    const pending = BossClient.fromAddon(`${base}/cancel`, { signal: controller.signal });
    const rejected = assert.rejects(pending, (error) => error.name === "AbortError");
    await streaming; controller.abort(); await rejected;
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test("M3U SDK discovery counts UTF-8 bytes and rejects links beyond its header budget", async () => {
  const { BossClient } = await import("../public/boss-client.mjs");
  let base, descriptors = 0;
  const timers = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/addon") { descriptors++; return reply(res, { format: "boss-media-addon", version: 1, resources: { catalogue: `${base}/catalogue` } }); }
    res.write("#EXTM3U " + "\u00e9".repeat(3000));
    const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) res.end("\u00e9".repeat(1500) + ` boss-addon-url="${base}/addon"\n`); }, 30);
    timers.add(timer);
  });
  try {
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve)); base = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(BossClient.fromM3u(`${base}/playlist`), /does not advertise Boss support/);
    assert.equal(descriptors, 0);
  } finally { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test("expanded search visits late feeds fairly and isolates a failed feed within one source", async () => {
  const engine = new MediaEngine(":memory:", { secret });
  const calls = [];
  const declaration = require("../core/model").capabilities({ catalog: true, search: true, types: ["movie"] });
  engine.registry.register("many-feeds", () => ({ id: "feeds", capabilities: declaration,
    catalogs: Array.from({ length: 64 }, (_, index) => ({ key: String(index), type: "movie", searchable: true, enumerable: false })),
    catalog: async () => ({ items: [], nextCursor: null }),
    search: async ({ key, cursor }) => {
      calls.push([key, cursor]);
      if (key === "1") throw new Error("One feed is unavailable");
      if (key === "0") return { items: [], nextCursor: String(Number(cursor || 0) + 1) };
      return { items: key === "63" ? [{ sourceKey: "late-film", type: "movie", title: "Discovery in final feed" }] : [], nextCursor: null };
    }
  }));
  try {
    await engine.addSource({ id: "feeds", protocol: "many-feeds", name: "Feeds", configuration: {} });
    const context = { sourceIds: ["feeds"], types: ["movie"], search: "Discovery", limit: 100 };
    const rows = await engine.search(context);
    assert.equal(rows[0].title, "Discovery in final feed");
    assert.deepEqual(calls.slice(0, 64).map(([key]) => key), Array.from({ length: 64 }, (_, i) => String(i)));
    assert.equal(calls.filter(([key]) => key === "0").length, 5);
    assert.equal(calls.filter(([key]) => key === "1").length, 1);
    const before = calls.length;
    await engine.search(context);
    assert.equal(calls.slice(before).filter(([key]) => key === "63").length, 0, "Completed feeds use cached discovery progress");
    assert.equal(calls.slice(before).filter(([key]) => key === "1").length, 1, "Failed feeds retry on a later request");
  } finally { await engine.close(); }
});
test("required catalogue filter options ingest stable metadata-only genre variants", async () => {
  const engine = new MediaEngine(":memory:", { secret });
  let options = ["Drama", "Sci-Fi & Fantasy"];
  const requests = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://fixture").pathname;
    if (path === "/manifest.json") return reply(res, { id: "test.genres", version: "1.0.0", name: "Genre catalogues", types: ["movie"], resources: ["catalog", "stream"], catalogs: [{ id: "genres", type: "movie", extra: [{ name: "genre", isRequired: true, options }, { name: "skip", isRequired: true }, { name: "search" }] }] });
    if (path.startsWith("/catalog/")) {
      const extra = new URLSearchParams(path.split("/").at(-1).replace(/\.json$/, ""));
      requests.push(Object.fromEntries(extra));
      if (!options.includes(extra.get("genre")) || !extra.has("skip")) { res.writeHead(400); return res.end(); }
      return reply(res, { metas: Number(extra.get("skip")) ? [] : [{ id: "tt1375666", type: "movie", name: "Shared genre movie" }] });
    }
    requests.push({ unexpected: path }); res.writeHead(404); res.end();
  });
  try {
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
    const configuration = { baseUrl: `http://127.0.0.1:${server.address().port}/manifest.json` };
    await engine.addSource({ id: "genres", protocol: "catalogue", name: "Genres", configuration });
    await engine.ingestSource("genres");
    const rows = engine.page({ sourceIds: ["genres"], types: ["movie"] });
    assert.equal(rows.length, 1, "Identity deduplicates overlapping genre feeds");
    assert.deepEqual(engine.graph.sql("SELECT name FROM Categories ORDER BY name").all().map((row) => row.name), [...options, "genres"].sort());
    assert.equal(engine.graph.sql("SELECT count(*) n FROM MediaCategories").get().n, 3);
    const keys = () => engine.graph.sql("SELECT catalog_key FROM SourceCatalogs ORDER BY catalog_key").all().map((row) => row.catalog_key);
    const original = keys(); assert.equal(original.length, 2);
    options.reverse(); await engine.ingestSource("genres", { refresh: true });
    assert.deepEqual(keys(), original, "Reordered preset values do not change catalogue identity");
    await engine.search({ sourceIds: ["genres"], types: ["movie"], search: "Shared", limit: 100 });
    assert.ok(requests.some((request) => request.search === "Shared" && request.genre === "Sci-Fi & Fantasy"));
    assert.ok(requests.every((request) => request.genre && !request.unexpected));
    options = Array.from({ length: 257 }, (_, i) => String(i));
    await assert.rejects(engine.addSource({ id: "too-many", protocol: "catalogue", name: "Too many", configuration }), /preset options/);
    assert.equal(engine.graph.source("too-many"), null);
  } finally { await engine.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test("archive windows in all outputs follow authorized mappings, not global merged channel metadata", async () => {
  const { OutputLibrary } = require("../protocols/library");
  const { createBossOutput } = require("../protocols/boss");
  const { createXtreamOutput } = require("../protocols/xtream");
  const { playlist } = require("../protocols/m3u");
  const engine = new MediaEngine(":memory:", { secret });
  const credentials = { server: "https://boss.example/xtream", username: "test", password: "test" };
  const collect = async (chunks) => { let result = ""; for await (const chunk of chunks) result += chunk; return result; };
  const put = (source, days, id = "123") => engine.graph.ingest(source, [{ sourceKey: source, type: "channel", title: id === "123" ? "Shared channel" : "Other channel", externalIDs: { tvdb: id }, channel: { catchupDays: days }, resolverData: { catchupDays: days } }])[0];
  try {
    for (const id of ["archive", "live", "other"]) engine.graph.addSource({ id, protocol: "fixture", name: id, configuration: {}, capabilities: { streams: true, catchup: id !== "live", types: ["channel"] } });
    const id = put("archive", 7); put("live", 0); put("other", 2, "456");
    const collection = engine.graph.createCollection({ name: "Scoped", sourceIds: ["live", "other"] });
    const library = new OutputLibrary(engine, collection, { play: () => "https://boss.example/play", artwork: () => "", epg: "https://boss.example/guide", boss: "https://boss.example/addon" });
    const boss = createBossOutput(library, "https://boss.example");
    const check = async (days) => {
      const page = await boss.catalogue(new URLSearchParams({ type: "channel" }));
      const media = page.items.find((item) => item.title === "Shared channel");
      assert.equal(media.channel.catchupDays, days);
      const rows = JSON.parse(await collect(createXtreamOutput(library, credentials).render(new URLSearchParams({ action: "get_live_streams" }))));
      const row = rows.find((item) => item.name === "Shared channel");
      assert.equal(row.tv_archive, days > 0 ? 1 : 0); assert.equal(row.tv_archive_duration, days);
      const line = (await collect(playlist(library, credentials))).split("\n").find((item) => item.includes(",Shared channel"));
      assert.equal(line.includes('catchup="xc"'), days > 0);
      if (days) assert.ok(line.includes(`catchup-days="${days}"`));
      return media.id;
    };
    assert.equal(engine.graph.media(id).channel.catchupDays, 7);
    const canonical = await check(0);
    await assert.rejects(boss.catchup(canonical, new URLSearchParams({ start: Date.now() - 3600000, end: Date.now() - 1800000 })), (error) => error.status === 422);
    engine.graph.sql("INSERT INTO CollectionSources VALUES(?,?)").run(collection.id, "archive");
    await check(7);
    put("archive", 1); await check(1);
    assert.equal(engine.graph.media(id).channel.catchupDays, 7, "Legacy aggregate is intentionally not the output authority");
    engine.graph.removeSource("archive"); await check(0);
  } finally { await engine.close(); }
});
test("author catch-up handler enforces channel windows and rejects prohibited resources", async () => {
  const { createBossAddon } = await import("../public/boss-addon.mjs");
  let calls = 0, prohibited = false;
  const server = createBossAddon({ id: "archive-sdk", name: "Archive SDK", baseUrl: "http://example.test", types: ["channel"], token: "archive-token" }, {
    catalogue: async () => ({ items: [], next: null }), playback: async () => [],
    media: async ({ id }) => ({ id, type: id === "film" ? "movie" : "channel", title: id, channel: { catchupDays: id === "no-archive" ? 0 : 2 } }),
    catchup: async () => { calls++; return [{ url: prohibited ? "https://example.test/file.torrent" : "https://example.test/archive.mp4" }]; }
  });
  try {
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: "Bearer archive-token" };
    const now = Date.now(), start = now - 3600000, end = now - 1800000;
    const get = (id, params = { start, end }) => fetch(`${base}/catchup/${id}?${new URLSearchParams(params)}`, { headers });
    assert.equal((await (await fetch(`${base}/addon`, { headers })).json()).capabilities.catchup, true);
    assert.equal((await fetch(`${base}/catchup/channel?start=${start}&end=${end}`)).status, 401);
    for (const id of ["film", "no-archive"]) assert.equal((await get(id)).status, 422);
    assert.equal((await get("channel", { start })).status, 400);
    assert.equal((await get("channel", { start, end: start })).status, 400);
    assert.equal((await get("channel", { start, end: now + 120000 })).status, 400);
    assert.equal((await get("channel", { start: start - 3 * 86400000, end: end - 3 * 86400000 })).status, 422);
    assert.equal(calls, 0);
    assert.equal((await (await get("channel")).json()).resources[0].url, "https://example.test/archive.mp4");
    prohibited = true;
    assert.equal((await get("channel")).status, 422);
    assert.equal(calls, 2);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test("native archive resolution preserves source-specific windows and interval cache separation", async () => {
  let base; const intervals = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname === "/addon") return reply(res, { format: "boss-media-addon", version: 1, capabilities: { streams: true, catchup: true, live: true, types: ["channel"] }, resources: { catalogue: `${base}/catalogue`, playback: `${base}/playback/{id}`, catchup: `${base}/catchup/{id}` } });
    if (url.pathname === "/catalogue") return reply(res, { items: [{ id: "channel", type: "channel", title: "Archived channel", channel: { catchupDays: 2 } }], next: null });
    if (url.pathname.startsWith("/catchup/")) {
      intervals.push([Number(url.searchParams.get("start")), Number(url.searchParams.get("end"))]);
      return reply(res, { resources: [{ url: `${base}/file.ts?${url.searchParams}`, container: "ts" }] });
    }
    return reply(res, { resources: [] });
  });
  const engine = new MediaEngine(":memory:", { secret });
  try {
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve)); base = `http://127.0.0.1:${server.address().port}`;
    const source = await engine.addSource({ id: "archive", protocol: "boss", name: "Archive", configuration: { baseUrl: base } });
    assert.equal(source.capabilities.catchup, true); assert.equal(source.capabilities.timeshift, false);
    await engine.ingestSource("archive");
    assert.equal(intervals.length, 0);
    const [channel] = engine.page({ sourceIds: ["archive"], types: ["channel"] });
    const start = Date.now() - 3600000, end = start + 1800000;
    const context = { allowedSourceIds: ["archive"], start, end };
    assert.equal((await engine.resolve(channel.id, context)).candidates.length, 1);
    assert.equal((await engine.resolve(channel.id, context)).candidates.length, 1);
    await engine.resolve(channel.id, { ...context, start: start - 3600000 });
    assert.deepEqual(intervals, [[start, end], [start - 3600000, end]]);
    await assert.rejects(engine.resolve(channel.id, { ...context, start: start - 3 * 86400000, end: end - 3 * 86400000 }), (error) => error.status === 422);
    assert.equal(intervals.length, 2, "Out-of-window requests never contact the provider");
  } finally { await engine.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test("author SDK streams authenticated guides into the graph and stops failed or cancelled streams", async () => {
  const { createBossAddon } = await import("../public/boss-addon.mjs");
  const engine = new MediaEngine(":memory:", { secret });
  let addon, base, mode = "normal", closed = 0, produced = 0;
  const server = http.createServer((req, res) => addon.emit("request", req, res));
  const headers = { Authorization: "Bearer private-guide" };
  try {
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    addon = createBossAddon({ id: "guide-sdk", name: "Guide SDK", baseUrl: base, token: "private-guide", types: ["channel"] }, {
      catalogue: async () => ({ items: [{ id: "channel", type: "channel", title: "Channel", channel: { epgId: "guide&one", number: "12" } }], next: null }),
      async *guide({}, { signal }) {
        try {
          do {
            signal.throwIfAborted(); produced++;
            yield { channelKey: "guide&one", title: "News & <Weather>", description: mode === "cancel" ? "x".repeat(65536) : "Today's news", startsAt: mode === "invalid" ? -1 : Date.now(), endsAt: Date.now() + 3600000 };
          } while (mode === "cancel");
        } finally { closed++; }
      }
    });
    assert.equal((await fetch(`${base}/guide`)).status, 401);
    const descriptor = await (await fetch(`${base}/addon`, { headers })).json();
    assert.equal(descriptor.capabilities.epg, true);
    assert.equal(descriptor.resources.guide, `${base}/guide`);
    assert.equal((await fetch(`${base}/guide`, { method: "HEAD", headers })).status, 200);
    assert.equal(produced, 0, "HEAD does not enumerate programmes");
    await engine.addSource({ id: "sdk", protocol: "boss", name: "Guide SDK", configuration: { baseUrl: base, apiKey: "private-guide" } });
    await engine.ingestSource("sdk");
    const event = engine.graph.sql("SELECT title,description FROM EPGEvents").get();
    assert.equal(event.title, "News & <Weather>");
    assert.equal(event.description, "Today's news");
    mode = "invalid";
    await assert.rejects(async () => (await fetch(`${base}/guide`, { headers })).text());
    mode = "cancel";
    const before = closed;
    const response = await fetch(`${base}/guide`, { headers });
    const reader = response.body.getReader(); await reader.read(); await reader.cancel();
    for (let attempt = 0; attempt < 100 && closed === before; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closed, before + 1, "Client cancellation closes the producer iterator");
    const count = produced;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(produced, count);
  } finally { await engine.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test("merged channels retain each source's guide identity during refresh and revocation", async () => {
  const engine = new MediaEngine(":memory:", { secret });
  const record = (key, epgId) => ({ type: "channel", sourceKey: key, title: "Shared channel", externalIDs: { tvdb: "1234" }, channel: { epgId } });
  const guide = (channelKey, title) => ({ async *epg() { yield { sourceKey: title, channelKey, title, startsAt: Date.now(), endsAt: Date.now() + 3600000 }; } });
  try {
    engine.graph.addSource({ id: "first", protocol: "fixture", name: "First", configuration: {} });
    engine.graph.addSource({ id: "second", protocol: "fixture", name: "Second", configuration: {} });
    const [id] = engine.graph.ingest("first", [record("first-key", "first-guide")]);
    assert.equal(engine.graph.ingest("second", [record("second-key", "second-guide")])[0], id);
    await engine.ingestEpg("first", guide("first-guide", "First event"));
    await engine.ingestEpg("second", guide("second-guide", "Second event"));
    assert.equal(engine.graph.sql("SELECT count(*) n FROM EPGEvents WHERE channel_id=?").get(id).n, 2);
    engine.graph.ingest("first", [record("first-key", "replacement-guide")]);
    await engine.ingestEpg("first", guide("first-guide", "Obsolete event"));
    await engine.ingestEpg("first", guide("replacement-guide", "Replacement event"));
    await engine.ingestEpg("second", guide("second-guide", "Second refreshed event"));
    assert.equal(engine.graph.sql("SELECT count(*) n FROM EPGEvents WHERE channel_id=?").get(id).n, 2);
    engine.graph.removeSource("first");
    assert.equal(engine.graph.sql("SELECT count(*) n FROM SourceGuideIDs").get().n, 1);
    assert.equal(engine.graph.sql("SELECT epg_id FROM SourceGuideIDs").get().epg_id, "second-guide");
  } finally { await engine.close(); }
});
test("native guide capability requires a declared guide and keeps authentication on its origin", async () => {
  const { createBossSource } = require("../sources/boss");
  let guide, base, calls = 0;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer guide-token") { res.writeHead(401); return res.end(); }
    if (req.url === "/addon") return reply(res, { format: "boss-media-addon", version: 1, capabilities: { epg: true, types: ["channel"] }, resources: { catalogue: `${base}/catalogue`, ...(guide ? { guide } : {}) } });
    calls++;
    res.setHeader("Content-Type", "application/xml");
    res.end('<tv><programme channel="one" start="20260906000000 +0000" stop="20260906010000 +0000"><title>Guide test</title></programme></tv>');
  });
  const source = () => createBossSource({ id: "guide", configuration: { baseUrl: base, apiKey: "guide-token" } });
  const events = async (adapter) => { const result = []; for await (const event of adapter.epg({})) result.push(event); return result; };
  try {
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const missing = await source();
    assert.equal(missing.capabilities.epg, false);
    assert.deepEqual(await events(missing), []);
    guide = `${base}/guide`;
    const valid = await source();
    assert.equal(valid.capabilities.epg, true);
    assert.equal((await events(valid))[0].title, "Guide test");
    assert.equal(calls, 1);
    guide = `http://localhost:${server.address().port}/guide`;
    await assert.rejects(events(await source()), /outside the configured source/);
    assert.equal(calls, 1, "Cross-origin guide is rejected before any request");
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test("author SDK private addon ingests series and resolves lazily through the native source", async () => {
  const { createBossAddon } = await import("../public/boss-addon.mjs");
  const { BossClient } = await import("../public/boss-client.mjs");
  const engine = new MediaEngine(":memory:", { secret });
  let base, plays = 0;
  const series = { id: "show", type: "series", title: "Owned series", identities: { imdb: "tt0903747" } };
  const episode = { id: "show:1:1", type: "episode", title: "Owned episode", seasonNumber: 1, episodeNumber: 1 };
  const movie = { id: "film", type: "movie", title: "Owned movie", identities: { imdb: "tt1375666" } };
  const config = { id: "sdk-test", name: "SDK test", baseUrl: "http://127.0.0.1/private", types: ["movie", "series", "episode"], token: "private-addon-test-token" };
  // A forwarding listener supplies its actual ephemeral port before descriptor creation.
  let addon;
  const server = http.createServer((req, res) => addon.emit("request", req, res));
  try {
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
    base = `http://127.0.0.1:${server.address().port}/private`;
    addon = createBossAddon({ ...config, baseUrl: base }, {
      catalogue: async ({ type, seriesId }) => ({ items: type === "series" ? [series] : type === "episode" && seriesId === "show" ? [episode] : type === "movie" ? [movie] : [], next: null }),
      search: async ({ search }) => ({ items: movie.title.includes(search) ? [movie] : [], next: null, nextOffset: null }),
      media: async ({ id }) => [series, episode, movie].find((item) => item.id === id),
      playback: async ({ id }) => { plays++; return [
        { url: `${base}/file/${id}.mp4`, codec: "h264", resolution: "on-request" },
        { url: "https://media.example/owned.mp4" },
        { url: `${base}/protected`, transport: "hls", codec: "hevc", resolution: { width: 3840, height: 2160 }, hdr: "HDR10", audio: [{ codec: "aac", language: "en" }], languages: ["en"], expiresAt: Date.now() + 60000, requiredHeaders: { authorization: "Bearer media-only", Referer: `${base}/player`, Host: "forbidden.example" } },
        { url: "https://media.example/protected", transport: "dash", requiredHeaders: { Authorization: "Bearer external-media-only", Origin: "https://player.example" } }
      ]; }
    });
    await assert.rejects(BossClient.fromAddon(`${base}/addon`), (error) => error.status === 401);
    const client = await BossClient.fromAddon(`${base}/addon`, { token: config.token });
    const downloaded = await fetch(`${base}/addon.boss`, { headers: { Authorization: `Bearer ${config.token}` } });
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get("content-disposition"), /addon\.boss/);
    const fileText = await downloaded.text();
    const hosted = await BossClient.fromAddon(`${base}/addon.boss`, { token: config.token });
    assert.equal((await hosted.search("Owned")).items[0].id, "film");
    for (const file of [fileText, new TextEncoder().encode(fileText), new Blob([fileText])]) {
      const imported = await BossClient.fromFile(file, { trustedOrigin: new URL(base).origin, token: config.token });
      assert.equal((await imported.search("Owned")).items[0].id, "film");
    }
    await assert.rejects(BossClient.fromFile(fileText), /trusted origin/);
    await assert.rejects(BossClient.fromFile(fileText, { trustedOrigin: "https://untrusted.example", token: config.token }), /trusted origin/);
    await assert.rejects(BossClient.fromFile("null", { trustedOrigin: base }), /Invalid Boss file/);
    await assert.rejects(BossClient.fromFile(new Uint8Array(8 * 1024 * 1024 + 1), { trustedOrigin: base }), error => error.status === 413);
    const altered = JSON.parse(fileText); altered.resources.catalogue = "https://untrusted.example/catalogue";
    const unsafe = await BossClient.fromFile(JSON.stringify(altered), { trustedOrigin: base, token: config.token });
    await assert.rejects(async () => unsafe.search("Owned"), /outside the configured addon/);
    assert.equal((await client.search("Owned")).items[0].id, "film");
    assert.equal((await client.media("film")).media.playbackState, "UNRESOLVED");
    assert.equal((await fetch(`${base.replace("private", "outside")}/media/film`, { headers: { Authorization: `Bearer ${config.token}` } })).status, 404);
    await engine.addSource({ id: "native", protocol: "boss", name: "Private", configuration: { baseUrl: `${base}/addon.boss`, apiKey: config.token } });
    await engine.ingestSource("native");
    assert.equal(plays, 0);
    const [stored] = engine.page({ sourceIds: ["native"], types: ["episode"] });
    assert.equal(stored.title, episode.title);
    assert.equal(engine.graph.media(stored.seriesId).externalIDs.imdb, series.identities.imdb);
    const resolved = await engine.resolve(stored.id, { allowedSourceIds: ["native"] });
    assert.equal(plays, 1);
    assert.equal(resolved.candidates.length, 4);
    const same = resolved.candidates.find((item) => item.resource.url.startsWith(`${base}/file/`));
    const other = resolved.candidates.find((item) => item.resource.url === "https://media.example/owned.mp4");
    assert.equal(same.requiredHeaders.Authorization, `Bearer ${config.token}`);
    assert.equal(same.resolution, null, "Lazy playback state is not a pixel resolution");
    assert.deepEqual(other.requiredHeaders, {});
    const protectedMedia = resolved.candidates.find((item) => item.resource.url === `${base}/protected`);
    assert.deepEqual(protectedMedia.requiredHeaders, { authorization: "Bearer media-only", Referer: `${base}/player` });
    assert.equal(protectedMedia.protocol, "hls");
    assert.equal(protectedMedia.resolution.height, 2160);
    assert.equal(protectedMedia.codec, "hevc");
    assert.equal(protectedMedia.hdr, "HDR10");
    assert.equal(protectedMedia.audio[0].codec, "aac");
    assert.ok(protectedMedia.expiresAt > Date.now());
    const external = resolved.candidates.find((item) => item.resource.url.endsWith("example/protected"));
    assert.equal(external.protocol, "dash");
    assert.equal(external.requiredHeaders.Authorization, "Bearer external-media-only");
    assert.ok(!JSON.stringify(external).includes(config.token));
    assert.ok(!JSON.stringify(stored).includes(config.token));
  } finally { await engine.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("app SDK rejects cross-origin API resources and redirects without leaking credentials", async () => {
  const { BossClient } = await import("../public/boss-client.mjs");
  let received = 0, mode = "cross-origin";
  const sink = http.createServer((req, res) => { received++; res.end("{}"); });
  let target, base;
  const server = http.createServer((req, res) => {
    if (req.url === "/addon") return reply(res, { format: "boss-media-addon", version: 1, resources: { catalogue: mode === "cross-origin" ? target : `${base}/catalogue` } });
    res.writeHead(302, { Location: target }); res.end();
  });
  try {
    await new Promise((resolve) => sink.listen(0, "0.0.0.0", resolve));
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
    target = `http://127.0.0.1:${sink.address().port}/catalogue`;
    base = `http://127.0.0.1:${server.address().port}`;
    for (mode of ["cross-origin", "redirect"]) {
      const client = await BossClient.fromAddon(`${base}/addon`, { token: "secret-token" });
      await assert.rejects(async () => client.catalogue());
    }
    assert.equal(received, 0);
  } finally {
    server.closeAllConnections(); sink.closeAllConnections();
    await new Promise((resolve) => server.close(resolve)); await new Promise((resolve) => sink.close(resolve));
  }
});
test("concurrent metadata searches coalesce and discard responses from revised or revoked sources", async () => {
  for (const change of ["revise", "revoke"]) {
    const engine = new MediaEngine(":memory:", { secret });
    let release, started;
    const entered = new Promise((resolve) => { started = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const declaration = require("../core/model").capabilities({ catalog: true, search: true, types: ["movie"] });
    engine.registry.register("fixture-search", () => ({ id: "one", capabilities: declaration, catalogs: [{ key: "search", type: "movie", searchable: true, enumerable: false }], catalog: async () => ({ items: [], nextCursor: null }), search: async () => {
      calls++; started(); await waiting;
      return { items: [{ type: "movie", sourceKey: "one", title: "Discovery" }], nextCursor: null };
    } }));
    try {
      await engine.addSource({ id: "one", protocol: "fixture-search", name: "Source", configuration: {} });
      const context = { sourceIds: ["one"], types: ["movie"], search: "Discovery", limit: 100 };
      const first = engine.search(context), second = engine.search(context);
      await entered;
      if (change === "revise") engine.graph.updateSource("one", { configuration: { changed: true } });
      else engine.graph.removeSource("one");
      release();
      assert.deepEqual(await first, []); assert.deepEqual(await second, []);
      assert.equal(calls, 1);
      assert.equal(engine.graph.sql("SELECT COUNT(*) AS n FROM MediaItems").get().n, 0);
      assert.equal(engine.searchRequests.size, 0);
    } finally { release(); await engine.close(); }
  }
});
test("engine catalogue, artwork and identity caches remain bounded and invalidate on graph changes", async () => {
  const engine = new MediaEngine(":memory:", { secret });
  try {
    engine.graph.addSource({ id: "one", protocol: "fixture", name: "One", configuration: {} });
    const [id] = engine.graph.ingest("one", [{ type: "movie", sourceKey: "film", title: "Original", artwork: { poster: "https://example.com/old.jpg" } }]);
    const page = engine.graph.page.bind(engine.graph), artwork = engine.graph.artwork.bind(engine.graph), synthetic = engine.graph.synthetic.bind(engine.graph);
    let pages = 0, art = 0, identities = 0;
    engine.graph.page = (context) => { pages++; return page(context); };
    engine.graph.artwork = (...args) => { art++; return artwork(...args); };
    engine.graph.synthetic = (...args) => { identities++; return synthetic(...args); };
    const context = { sourceIds: ["one"], types: ["movie"] };
    engine.page(context)[0].title = "Untrusted mutation";
    assert.equal(engine.page(context)[0].title, "Original"); assert.equal(pages, 1);
    engine.artwork(id, ["one"]).poster.resource.url = "https://example.com/forged.jpg";
    assert.equal(engine.artwork(id, ["one"]).poster.resource.url, "https://example.com/old.jpg"); assert.equal(art, 1);
    const outputId = engine.synthetic("xtream", id);
    assert.equal(engine.synthetic("xtream", id), outputId); assert.equal(identities, 1);
    engine.graph.ingest("one", [{ type: "movie", sourceKey: "film", title: "Updated", artwork: { poster: "https://example.com/new.jpg" } }]);
    assert.equal(engine.page(context)[0].title, "Updated"); assert.equal(pages, 2);
    assert.equal(engine.artwork(id, ["one"]).poster.resource.url, "https://example.com/new.jpg"); assert.equal(art, 2);
    engine.graph.removeSource("one");
    assert.deepEqual(engine.page(context), []); assert.deepEqual(engine.artwork(id, ["one"]), {});
    for (const cache of Object.values(engine.caches)) assert.ok(cache.bytes <= cache.maxBytes && cache.values.size <= cache.maxEntries);
  } finally { await engine.close(); }
});
test("refresh retires removed root catalogues and episodes without changing surviving canonical IDs", async () => {
  let catalogue = "first", episodeCount = 2, includeSeries = true, nativeSuffix = "";
  const mock = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://fixture").pathname;
    if (pathname === "/manifest.json") return reply(res, { id: "test.refresh", version: "1.0.0", name: "Refresh fixture", resources: ["catalog", "meta"], types: ["series"], catalogs: [{ id: catalogue, type: "series" }] });
    if (pathname.startsWith("/catalog/")) return reply(res, { metas: includeSeries ? [{ id: "tt0903747", type: "series", name: "Series" }] : [] });
    if (pathname.startsWith("/meta/")) return reply(res, { meta: { id: "tt0903747", type: "series", name: "Series", videos: Array.from({ length: episodeCount }, (_, index) => ({ id: `tt0903747:1:${index + 1}${nativeSuffix}`, title: `Episode ${index + 1}`, season: 1, episode: index + 1 })) } });
    res.writeHead(404); res.end();
  });
  const engine = new MediaEngine(":memory:", { secret });
  try {
    await new Promise((resolve) => mock.listen(0, "0.0.0.0", resolve));
    await engine.addSource({ id: "one", protocol: "other", name: "Refresh", configuration: { baseUrl: `http://127.0.0.1:${mock.address().port}/manifest.json` } });
    await engine.ingestSource("one");
    const episodes = engine.page({ sourceIds: ["one"], types: ["episode"] });
    assert.equal(episodes.length, 2);
    const synthetic = engine.graph.synthetic("xtream", episodes[0].id);
    episodeCount = 1; catalogue = "replacement";
    await engine.ingestSource("one", { refresh: true });
    const refreshed = engine.page({ sourceIds: ["one"], types: ["episode"] });
    assert.equal(refreshed.length, 1, "explicit sync must bypass old source-response caches");
    assert.equal(engine.graph.synthetic("xtream", refreshed[0].id), synthetic);
    assert.equal(engine.graph.sql("SELECT COUNT(*) AS n FROM IngestionJobs WHERE catalog_key=?").get("0:series:first").n, 0);
    includeSeries = false;
    await engine.ingestSource("one", { refresh: true });
    assert.equal(engine.page({ sourceIds: ["one"], types: ["episode"] }).length, 0, "episodes of removed series must become unavailable");
    includeSeries = true; episodeCount = 2;
    await engine.ingestSource("one", { refresh: true });
    assert.equal(engine.page({ sourceIds: ["one"], types: ["episode"] }).length, 2);
    assert.equal(engine.graph.synthetic("xtream", episodes[0].id), synthetic);
    nativeSuffix = ":new-native-id";
    await engine.ingestSource("one", { refresh: true });
    const mappings = engine.graph.mappings(episodes[0].id, ["one"]);
    assert.equal(mappings.length, 1); assert.ok(mappings[0].sourceKey.endsWith(nativeSuffix));
    assert.equal(engine.graph.synthetic("xtream", episodes[0].id), synthetic);
  } finally { await engine.close(); mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); }
});
function reply(res, data) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); }
test("real addon source ingests canonical metadata then resolves exact IMDb episode identity lazily", async () => {
  let streams = 0;
  let requestedId;
  const mock = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://test").pathname);
    if (path === "/manifest.json") return reply(res, { id: "test.addon", version: "1.0.0", name: "Test", resources: ["catalog", "meta", "stream", "subtitles"], types: ["movie", "series"], idPrefixes: ["tt"], catalogs: [{ id: "shows", type: "series", extra: [{ name: "skip" }] }] });
    if (path.startsWith("/catalog/")) return reply(res, { metas: path.includes("skip=") ? [] : [{ id: "tt0903747", type: "series", name: "Breaking Bad", releaseInfo: "2008", tmdb_id: 1396 }] });
    if (path.startsWith("/meta/")) return reply(res, { meta: { id: "tt0903747", type: "series", name: "Breaking Bad", videos: [{ id: "tt0903747:1:1", title: "Pilot", season: 1, episode: 1, released: "2008-01-20T00:00:00Z" }] } });
    if (path.startsWith("/stream/")) { streams++; requestedId = path.split("/").at(-1).replace(/\.json$/, ""); return reply(res, { streams: [{ url: "https://debrid.example/resolved.mp4", codec: "h264" }, { infoHash: "not-allowed" }] }); }
    return reply(res, { subtitles: [] });
  });
  const engine = new MediaEngine(":memory:", { secret });
  try {
    await new Promise((resolve) => mock.listen(0, "0.0.0.0", resolve));
    const source = await engine.addSource({ id: "one", protocol: "other", name: "Library", configuration: { baseUrl: `http://127.0.0.1:${mock.address().port}/manifest.json` } });
    assert.equal(source.capabilities.epg, false); assert.equal(source.capabilities.subtitles, true);
    await engine.ingestSource("one");
    assert.equal(streams, 0);
    const series = engine.page({ sourceIds: ["one"] })[0];
    assert.equal(series.externalIDs.imdb, "tt0903747"); assert.equal(series.externalIDs.tmdb, "1396");
    await engine.metadata(series.id, { allowedSourceIds: ["one"] });
    const episode = engine.page({ sourceIds: ["one"], types: ["episode"] })[0];
    assert.equal(contentId(episode, series), "tt0903747:1:1");
    assert.equal(streams, 0);
    const result = await engine.resolve(episode.id, { allowedSourceIds: ["one"], output: "xtream", codecs: ["h264"] });
    assert.equal(requestedId, "tt0903747:1:1"); assert.equal(result.candidates.length, 1); assert.equal(streams, 1);
  } finally { await engine.close(); mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); }
});
for (const protocol of ["jellyfin", "emby"]) test(`${protocol} metadata keeps its deadline with caller cancellation and closes denied responses`, { timeout: 45000 }, async () => {
  const { createMediaServerSource } = require("../sources/media-server");
  let mode = "stall", entered, closed;
  const mock = http.createServer((req, res) => {
    entered?.();
    res.on("close", () => closed?.());
    if (mode === "denied") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.write("{");
    }
  });
  try {
    await new Promise(resolve => mock.listen(0, "0.0.0.0", resolve));
    const adapter = await createMediaServerSource({ id: "one", protocol,
      configuration: { baseUrl: `http://127.0.0.1:${mock.address().port}`, apiKey: "private" } });
    const external = new AbortController();
    const started = Date.now();
    await assert.rejects(adapter.catalog({ key: "movies", limit: 1, signal: external.signal }));
    assert.ok(Date.now() - started < 20000, "An active caller signal must not disable the source deadline");
    assert.equal(external.signal.aborted, false);
    const caller = new AbortController();
    const received = new Promise(resolve => { entered = resolve; });
    const rejected = assert.rejects(adapter.catalog({ key: "movies", limit: 1, signal: caller.signal }));
    await received;
    caller.abort();
    await rejected;
    entered = null;
    mode = "denied";
    const disconnected = new Promise(resolve => { closed = resolve; });
    const request = adapter.catalog({ key: "movies", limit: 1 });
    // Fetch can reject denied headers immediately; the SDK buffers bodies,
    // which must still obey the request deadline before rejecting.
    if (protocol === "emby") {
      await assert.rejects(request, { status: 401 });
    } else {
      const deniedAt = Date.now();
      await assert.rejects(request);
      assert.ok(Date.now() - deniedAt < 20000, "Denied SDK response bodies must remain bounded");
    }
    let timer;
    try {
      await Promise.race([disconnected, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Denied response was not closed")), 1000);
      })]);
    } finally { clearTimeout(timer); }
  } finally { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
});
for (const protocol of ["jellyfin", "emby"]) test(`${protocol} live sources ingest scoped channels and EPG without opening tuners`, async () => {
  const { createMediaServerSource } = require("../sources/media-server");
  let origin, playbackRequests = 0, mediaRequests = 0, liveRequests = 0, guideDenied = false;
  const userId = "a".repeat(32), now = Date.now();
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://test"), params = Object.fromEntries([...url.searchParams].map(([key, value]) => [key.toLowerCase(), value]));
    assert.ok(req.headers.authorization || req.headers["x-emby-token"]);
    if (url.pathname === "/LiveTv/Info") { liveRequests++; return reply(res, { IsEnabled: true, EnabledUsers: [userId] }); }
    if (url.pathname.startsWith("/LiveTv/")) {
      liveRequests++;
      assert.equal(params.userid, userId);
      if (url.pathname === "/LiveTv/Channels") return reply(res, { Items: [{ Id: "live-1", Name: "Owned live channel", ChannelNumber: "7", ChannelType: "TV", ImageTags: { Primary: "tag" } }], TotalRecordCount: 1 });
      if (url.pathname === "/LiveTv/Channels/live-1") return reply(res, { Id: "live-1", Name: "Owned live channel", ChannelNumber: "7" });
      if (url.pathname === "/LiveTv/Programs") {
        if (guideDenied) { res.writeHead(403); return res.end(); }
        return reply(res, { Items: [{ Id: "show-1", ChannelId: "live-1", Name: "Owned programme", StartDate: new Date(now - 1000).toISOString(), EndDate: new Date(now + 3600000).toISOString() }], TotalRecordCount: 1 });
      }
    }
    if (url.pathname === "/Items/live-1/PlaybackInfo") {
      playbackRequests++;
      let text = ""; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      assert.equal(body.UserId, userId); assert.equal(body.AutoOpenLiveStream, false); assert.equal(body.EnableTranscoding, false); assert.equal(body.EnableDirectStream, false);
      return reply(res, { MediaSources: [
        { Id: "direct", SupportsDirectPlay: true, Path: `${origin}/authorized.ts`, Container: "ts", MediaStreams: [{ Type: "Video", Codec: "h264" }] },
        { Id: "external", SupportsDirectPlay: true, Path: "https://authorized-cdn.example/live.m3u8", RequiredHttpHeaders: { Referer: "https://authorized-cdn.example/" } },
        { Id: "tuner", SupportsDirectPlay: true, RequiresOpening: true, OpenToken: "private-tuner-token", Path: `${origin}/tuner.ts` },
        { Id: "leased", SupportsDirectPlay: true, RequiresClosing: true, LiveStreamId: "private-lease", Path: `${origin}/leased.ts` },
        { Id: "transcode", SupportsDirectPlay: false, TranscodingUrl: `${origin}/transcode.m3u8` },
        { Id: "torrent", SupportsDirectPlay: true, Path: "magnet:?xt=urn:btih:forbidden" }
      ] });
    }
    if (url.pathname === "/Items") return reply(res, { Items: [], TotalRecordCount: 0 });
    mediaRequests++; res.writeHead(500); res.end();
  });
  const engine = new MediaEngine(":memory:", { secret });
  try {
    await new Promise(resolve => mock.listen(0, "0.0.0.0", resolve));
    origin = `http://127.0.0.1:${mock.address().port}`;
    const configuration = { baseUrl: origin, apiKey: "private-live-key", userId };
    await engine.addSource({ id: "owned-live", protocol, name: "Live source", configuration });
    await engine.ingestSource("owned-live");
    assert.equal(playbackRequests, 0); assert.equal(mediaRequests, 0);
    const declaration = engine.graph.source("owned-live").capabilities;
    assert.equal(declaration.live, true); assert.equal(declaration.epg, true); assert.equal(declaration.catchup, false);
    const [channel] = engine.page({ sourceIds: ["owned-live"], types: ["channel"] });
    assert.equal(channel.title, "Owned live channel"); assert.equal(channel.channel.number, "7");
    const event = engine.graph.sql("SELECT * FROM EPGEvents").get();
    assert.equal(event.channel_id, channel.id); assert.equal(event.title, "Owned programme");
    const result = await engine.resolve(channel.id, { allowedSourceIds: ["owned-live"] });
    assert.equal(playbackRequests, 1); assert.equal(result.candidates.length, 2);
    const direct = result.candidates.find(candidate => candidate.protocol === "http"), external = result.candidates.find(candidate => candidate.protocol === "hls");
    assert.ok(JSON.stringify(direct.requiredHeaders).includes("private-live-key"));
    assert.deepEqual(external.requiredHeaders, { Referer: "https://authorized-cdn.example/" });
    assert.equal(mediaRequests, 0);
    const { OutputLibrary } = require("../protocols/library");
    const { createJellyfinLive } = require("../protocols/jellyfin-live");
    const collection = engine.graph.createCollection({ name: "Live output", sourceIds: ["owned-live"] });
    const guide = createJellyfinLive(new OutputLibrary(engine, collection, {})).programs({});
    assert.equal(guide.TotalRecordCount, 1); assert.equal(guide.Items[0].Name, "Owned programme");
    const before = liveRequests;
    for (const config of [{ ...configuration, userId: "" }, { ...configuration, libraryPath: "restricted-folder" }]) {
      const adapter = await createMediaServerSource({ id: "restricted", protocol, configuration: config });
      assert.equal(adapter.capabilities.live, false);
    }
    assert.equal(liveRequests, before);
    const unauthorized = await createMediaServerSource({ id: "unauthorized", protocol, configuration: { ...configuration, userId: "b".repeat(32) } });
    assert.equal(unauthorized.capabilities.live, false);
    guideDenied = true;
    const noGuide = await createMediaServerSource({ id: "no-guide", protocol, configuration });
    assert.equal(noGuide.capabilities.live, true); assert.equal(noGuide.capabilities.epg, false);
  } finally { await engine.close(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
});
for (const protocol of ["jellyfin", "emby"]) test(`${protocol} canonical source uses server identity and retains credential headers`, async () => {
  let playbackLookups = 0;
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, "http://test");
    assert.ok(req.headers.authorization || req.headers["x-emby-token"]);
    const ids = url.searchParams.get("ids") || url.searchParams.get("Ids");
    if (ids) playbackLookups++;
    const type = url.searchParams.get("includeItemTypes") || url.searchParams.get("IncludeItemTypes");
    if (type === "Series") return reply(res, { Items: [], TotalRecordCount: 0 });
    return reply(res, { Items: [{ Id: "native-1", Type: "Movie", Name: "Inception", ProviderIds: { Imdb: "tt1375666", Tmdb: "27205" }, MediaSources: [{ Id: "version1", Container: "mp4", MediaStreams: [{ Type: "Video", Codec: "h264", Width: 1920, Height: 1080 }, { Type: "Audio", Codec: "aac", Language: "en" }] }] }], TotalRecordCount: 1 });
  });
  const engine = new MediaEngine(":memory:", { secret });
  try {
    await new Promise((resolve) => mock.listen(0, "0.0.0.0", resolve));
    await engine.addSource({ id: "one", protocol, name: "Library", configuration: { baseUrl: `http://127.0.0.1:${mock.address().port}`, apiKey: "private-api-key" } });
    await engine.ingestSource("one"); assert.equal(playbackLookups, 0);
    const film = engine.page({ sourceIds: ["one"] })[0]; assert.equal(film.externalIDs.imdb, "tt1375666");
    const resolved = await engine.resolve(film.id, { allowedSourceIds: ["one"], codecs: ["h264"] });
    assert.equal(resolved.selected.codec, "h264"); assert.equal(resolved.selected.resolution.height, 1080);
    assert.ok(JSON.stringify(resolved.selected.requiredHeaders).includes("private-api-key"));
    assert.ok(!JSON.stringify(film).includes("private-api-key"));
  } finally { await engine.close(); mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); }
});

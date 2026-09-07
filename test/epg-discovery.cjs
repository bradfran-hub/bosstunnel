"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { MediaEngine } = require("../core/engine");
const { OutputLibrary } = require("../protocols/library");
const { createBossOutput } = require("../protocols/boss");
const { xmltv: exportGuide } = require("../protocols/m3u");
const { xmltv: parseGuide, probeXmltv } = require("../sources/xmltv");
test("large buffered programme feeds yield to server I/O between bounded batches", async () => {
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(`<tv>${'<programme channel="one" start="20260907120000 +0000" stop="20260907130000 +0000"><title>Guide fixture</title></programme>'.repeat(1000)}</tv>`));
    controller.close();
  } });
  let records = 0;
  for await (const event of parseGuide(body)) { assert.ok(event.title); if (++records === 200) assert.equal(yielded, true); }
  assert.equal(records, 1000);
});
test("Xtream and M3U discover authenticated programme feeds and merge them through native, Xtream and M3U SDK guides", async () => {
  const engine = new MediaEngine(":memory:", { secret: "epg-discovery-fixture-encryption-secret" });
  const { BossClient } = await import("../public/boss-client.mjs");
  let origin, status = 200, automaticCalls = 0, library;
  const time = value => new Date(value).toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14) + " +0000";
  const startsAt = Math.floor(Date.now() / 3600000) * 3600000;
  const guide = key => `<?xml version="1.0"?><!DOCTYPE tv SYSTEM "xmltv.dtd"><tv><programme channel="${key}" start="${time(startsAt)}" stop="${time(startsAt + 3600000)}"><title>${key} programme</title><desc>Programme description</desc></programme></tv>`;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === "/provider/player_api.php") {
        assert.equal(url.searchParams.get("username"), "provider-user"); assert.equal(url.searchParams.get("password"), "provider-secret");
        const action = url.searchParams.get("action");
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(!action ? { user_info: { auth: 1 } } : action === "get_live_streams" ? [{ stream_id: 12, name: "Provider channel", epg_channel_id: "xtream-guide" }, { stream_id: 13, name: "Provider channel HD", epg_channel_id: "xtream-guide" }] : []));
      }
      if (url.pathname === "/provider/xmltv.php") {
        automaticCalls++; assert.equal(url.searchParams.get("password"), "provider-secret");
        res.writeHead(status, { "Content-Type": "application/xml" }); return res.end(status === 200 ? guide("xtream-guide") : "Unavailable");
      }
      if (url.pathname === "/source.m3u") return res.end(`#EXTM3U x-tvg-url="/playlist-guide.xml"\n#EXTINF:-1 tvg-id="m3u-guide",Playlist channel\n${origin}/live.ts\n`);
      if (url.pathname === "/playlist-guide.xml") { res.setHeader("Content-Type", "application/xml"); return res.end(guide("m3u-guide")); }
      if (url.pathname === "/html") return res.end("<html><body>Not a guide</body></html>");
      if (url.pathname === "/oversized") return res.end(" ".repeat(65536) + "<tv/>");
      if (url.pathname === "/addon.boss") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify(createBossOutput(library, origin).descriptor())); }
      if (url.pathname === "/playlist.m3u") return res.end(`#EXTM3U boss-addon-url="${origin}/addon.boss"\n`);
      if (["/xtream/boss_api", "/xtream/xmltv.php"].includes(url.pathname)) {
        let body = ""; for await (const part of req) body += part;
        const params = new URLSearchParams(body);
        assert.equal(params.get("username"), "boss-user"); assert.equal(params.get("password"), "boss-secret");
        if (url.pathname.endsWith("boss_api")) { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify(createBossOutput(library, origin).descriptor())); }
      }
      if (["/xmltv.xml", "/xtream/xmltv.php"].includes(url.pathname)) {
        res.setHeader("Content-Type", "application/xml");
        for await (const chunk of exportGuide(library)) res.write(chunk);
        return res.end();
      }
      res.writeHead(404); res.end();
    } catch { res.destroy(); }
  });
  try {
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
    const configuration = { baseUrl: `${origin}/provider`, username: "provider-user", password: "provider-secret" };
    await engine.addSource({ id: "xtream", name: "Xtream", protocol: "xtream", configuration });
    await engine.addSource({ id: "m3u", name: "M3U", protocol: "m3u", configuration: { baseUrl: `${origin}/source.m3u` } });
    await engine.ingestSource("xtream"); await engine.ingestSource("m3u");
    assert.equal(engine.graph.source("xtream").capabilities.epg, true); assert.equal(engine.graph.source("m3u").capabilities.epg, true);
    assert.equal(engine.graph.sql("SELECT count(*) n FROM EPGEvents").get().n, 3);
    const lookup = [...engine.graph.statements.keys()].find(sql => sql.startsWith("INSERT INTO GuideStage SELECT"));
    assert.match(engine.graph.sql(`EXPLAIN QUERY PLAN ${lookup}`).all("job", "key", "title", "", 0, 1, "{}", "xtream", "xtream-guide")[0].detail, /SourceGuideIDs_lookup/);
    const collection = engine.graph.createCollection({ name: "Merged guide", sourceIds: ["xtream", "m3u"] });
    library = new OutputLibrary(engine, collection, { artwork: () => "" });
    const descriptor = createBossOutput(library, origin).descriptor();
    assert.equal(descriptor.resources.guide, `${origin}/xmltv.xml`);
    const channelPage = await createBossOutput(library, origin).catalogue(new URLSearchParams({ type: "channel" }));
    const ids = channelPage.items.map(channel => channel.channel.epgId).sort();
    for (const client of [await BossClient.fromAddon(`${origin}/addon.boss`), await BossClient.fromM3u(`${origin}/playlist.m3u`), await BossClient.fromXtream(`${origin}/xtream`, "boss-user", "boss-secret")]) {
      const response = await client.guide(), programmes = [];
      for await (const programme of parseGuide(response.body)) programmes.push(programme);
      assert.deepEqual(programmes.map(event => event.channelKey).sort(), ids);
      assert.deepEqual(programmes.map(event => event.title).sort(), ["m3u-guide programme", "xtream-guide programme", "xtream-guide programme"]);
    }
    const before = automaticCalls;
    const override = await require("../sources/xtream").createXtreamSource({ id: "override", configuration: { ...configuration, xmltvUrl: `${origin}/playlist-guide.xml` } });
    assert.equal(override.capabilities.epg, true); assert.equal(automaticCalls, before);
    for (const unavailable of [401, 404, 500]) {
      status = unavailable;
      const missing = await require("../sources/xtream").createXtreamSource({ id: "missing", configuration });
      assert.equal(missing.capabilities.epg, false); assert.equal(missing.capabilities.streams, true);
    }
    assert.equal(await probeXmltv(`${origin}/html`), false); assert.equal(await probeXmltv(`${origin}/oversized`), false);
    const unsupported = new BossClient({ capabilities: {}, resources: {} }, () => { throw new Error("No request expected"); });
    assert.throws(() => unsupported.guide(), { status: 422 });
    const unsafe = BossClient.connectDescriptor({ capabilities: { epg: true }, resources: { guide: "http://unrelated.invalid/guide" } }, new URL(`${origin}/addon.boss`), "private-token");
    assert.throws(() => unsafe.guide(), { status: 400 });
    const redirected = BossClient.connectDescriptor({ capabilities: { epg: true }, resources: { guide: `${origin}/html` } }, new URL(`${origin}/addon.boss`));
    await assert.rejects(redirected.guide(), /unavailable or invalid/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await engine.close(); }
});

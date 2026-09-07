"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");

test("all playback outputs hand off exact upstream URLs without fetching media", async () => {
  const directory = await fs.mkdtemp("/tmp/boss-direct-");
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, { DATA_DIR: directory, BASE_PATH: "/", PUBLIC_BASE_URL: base,
    BOSS_ADMIN_TOKEN: "test-only-direct-administration", BOSS_SECRET: "test-only-direct-encryption-secret" });
  const app = require("../server");
  const requests = [];
  server.on("request", (req, res) => {
    if (req.url.startsWith("/fixture")) {
      requests.push({ url: req.url, headers: req.headers });
      if (req.url === "/fixture.m3u8") {
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        return res.end("#EXTM3U\n#EXTINF:10,\nfixture.ts\n");
      }
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 0-3/4", "Content-Length": "4" });
      return res.end("BOSS");
    }
    app.server.emit("request", req, res);
  });
  try {
    await app.ready;
    const graph = app.engine.graph;
    const sourceId = graph.addSource({ protocol: "xtream", name: "Owned provider", configuration: {}, capabilities: { streams: true, types: ["movie"] } });
    const media = graph.media(graph.ingest(sourceId, [{ type: "movie", title: "Fixture", sourceKey: "one" }])[0]);
    const collection = graph.createCollection({ name: "Fixture", sourceIds: [sourceId] });
    const exact = `${base}/fixture.mp4?private=credential&signature=a%2Fb%3D`;
    app.engine.registry.get = async () => ({ capabilities: { streams: true }, async resolve() { return [
      { url: exact, requiredHeaders: { Authorization: "Bearer fixture-secret" }, resolution: { height: 1080 } },
      { url: `${base}/fixture.m3u8` }
    ]; } });
    const root = `${base}/a/${collection.id}`;
    const endpoint = `${root}/boss/playback/${media.canonicalId}`;
    const body = await (await fetch(endpoint)).json();
    assert.equal(body.resources.length, 3);
    const chosen = body.resources.find(resource => resource.mode === "selected" && resource.transport === "http");
    assert.equal(chosen.url, exact);
    assert.equal(chosen.name, "1080p");
    assert.equal(chosen.requiredHeaders.Authorization, "Bearer fixture-secret");
    assert.equal(chosen.headerOrigin, base);
    assert.equal(chosen.delivery, "direct");
    const addon = await (await fetch(`${root}/stream/movie/boss:${media.canonicalId}.json`)).json();
    assert.equal(addon.streams.length, 2);
    assert.equal(addon.streams[0].url, exact);
    assert.equal(addon.streams[0].name, "1080p");
    assert.equal(addon.streams[0].behaviorHints.proxyHeaders.request.Authorization, "Bearer fixture-secret");
    assert.equal(requests.length, 0, "metadata and playback APIs do not fetch media");
    const password = crypto.createHmac("sha256", crypto.createHash("sha256").update(process.env.BOSS_SECRET).digest()).update(`xtream:${collection.id}`).digest("hex").slice(0, 32);
    const xtream = `${base}/xtream/movie/${collection.id}/${password}/${app.engine.synthetic("xtream", media.id)}.mp4`;
    for (const route of [xtream, `${root}/play/${media.canonicalId}`]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(route, { method, headers: { Range: "bytes=0-3" }, redirect: "manual" });
        assert.equal(response.status, 307);
        assert.equal(response.headers.get("location"), `${base}/fixture.m3u8`);
        assert.match(response.headers.get("cache-control"), /no-store/);
        assert.equal(await response.text(), "");
      }
    }
    assert.equal(requests.length, 0, "redirecting GET, HEAD and range requests never contacts media");
    const { playbackRequest } = await import("../public/boss-client.mjs");
    assert.throws(() => playbackRequest(chosen), error => error.status === 422);
    const request = playbackRequest(chosen, { supportsHeaders: true });
    const response = await fetch(request.url, { headers: { ...request.headers, Range: "bytes=0-3" } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), "BOSS");
    assert.equal(requests[0].headers.authorization, "Bearer fixture-secret");
    assert.equal(requests[0].headers.range, "bytes=0-3");
    const hls = body.resources.find(resource => resource.transport === "hls");
    assert.equal(await (await fetch(hls.url)).text(), "#EXTM3U\n#EXTINF:10,\nfixture.ts\n");

    const value = { collectionId: collection.id, collectionRevision: collection.revision, sourceId,
      revision: graph.source(sourceId).revision, resource: { url: exact }, expires: Date.now() + 60000,
      playback: { mediaId: media.canonicalId, expires: Date.now() + 60000 } };
    const legacy = item => `${root}/resource/${Buffer.from(graph.secrets.seal(item)).toString("base64url")}`;
    const redeemed = await fetch(legacy(value), { redirect: "manual" });
    assert.equal(redeemed.status, 307); assert.equal(redeemed.headers.get("location"), exact);
    assert.equal((await fetch(legacy({ ...value, resource: { url: exact, headers: chosen.requiredHeaders } }), { redirect: "manual" })).status, 422);
    assert.equal((await fetch(legacy({ ...value, expires: 1 }), { redirect: "manual" })).status, 403);
    graph.updateCollection(collection.id, { ...collection, profile: { maxHeight: 720 } });
    assert.equal((await fetch(legacy(value), { redirect: "manual" })).status, 403);
    assert.equal(requests.length, 2, "legacy tickets never relay bytes");
    const descriptor = await (await fetch(`${root}/addon.boss`)).json();
    assert.equal(descriptor.playbackDelivery.proxiesMedia, false);
    assert.equal(descriptor.playbackDelivery.rewritesHls, false);
    const { BossClient } = await import("../public/boss-client.mjs");
    // Reset the profile to check identical choices through every BOSS discovery mode.
    graph.updateCollection(collection.id, { ...graph.collection(collection.id), profile: {} });
    for (const client of [await BossClient.fromAddon(`${root}/addon.boss`),
      await BossClient.fromXtream(`${base}/xtream`, collection.id, password),
      await BossClient.fromM3u(`${root}/playlist.m3u`)]) {
      const result = await client.playback(media.canonicalId);
      assert.equal(result.resources.find(resource => resource.name === "1080p").url, exact);
    }
    app.engine.registry.get = async () => ({ capabilities: { streams: true }, async resolve() {
      return [{ url: exact, requiredHeaders: { Authorization: "Bearer fixture-secret" } }];
    } });
    graph.updateSource(sourceId, { configuration: { replaced: true } });
    assert.equal((await fetch(xtream, { redirect: "manual" })).status, 422);
    const headerOnly = await (await fetch(endpoint)).json();
    assert.equal(headerOnly.resources.length, 1);
    assert.equal(headerOnly.resources[0].url, exact);
    assert.equal(headerOnly.resources[0].delivery, "direct");
    assert.equal(requests.length, 2, "header-only and extended SDK requests never relay media");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("SDK rejects expired, unsafe or header-incompatible resources without network access", async () => {
  const { playbackRequest } = await import("../public/boss-client.mjs");
  for (const resource of [
    { url: "magnet:forbidden" }, { url: "https://example.invalid/file.torrent" },
    { url: "https://user:password@example.invalid/file.mp4" },
    { url: "https://example.invalid/file.mp4", expiresAt: 1 },
    { url: "https://example.invalid/file.mp4", requiredHeaders: { Authorization: "bad\r\nheader" } },
    { url: "https://example.invalid/file.mp4", headerOrigin: "https://different.invalid" }
  ]) assert.throws(() => playbackRequest(resource, { supportsHeaders: true }));
  assert.equal(playbackRequest({ url: "https://example.invalid/a%2Fb?token=x%3D", expiresAt: null }).url, "https://example.invalid/a%2Fb?token=x%3D");
});

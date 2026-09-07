"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

test("addon SDK requires complete numeric resolution pairs without fetching media", async () => {
  const { createBossAddon } = await import("../public/boss-addon.mjs");
  let resolution = { height: 1080 }, handler;
  const server = http.createServer((req, res) => handler.emit("request", req, res));
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  handler = createBossAddon({ id: "test.dimensions", name: "Fixture", baseUrl, types: ["movie"] }, {
    playback: () => [{ url: "https://media.example.invalid/unchanged.mp4", resolution }]
  });
  try {
    for (const invalid of [{ height: 1080 }, { width: 1920 }, "on-request", { width: 0, height: 1080 }]) {
      resolution = invalid;
      assert.equal((await fetch(`${baseUrl}/playback/fixture`)).status, 422);
    }
    for (const valid of [{ width: 1920, height: 1080 }, { width: 3840, height: 2160, inferred: true }, null]) {
      resolution = valid;
      const response = await fetch(`${baseUrl}/playback/fixture`);
      assert.equal(response.status, 200);
      const resource = (await response.json()).resources[0];
      assert.deepEqual(resource.resolution, valid);
      assert.equal(resource.url, "https://media.example.invalid/unchanged.mp4");
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("SDK separates trusted API endpoints from mixed HTTP/HTTPS direct media choices", async () => {
  const { BossClient, playbackRequest } = await import("../public/boss-client.mjs");
  const requests = [];
  let base;
  const upstream = [{ url: "https://cdn.example.invalid/signed.mp4?token=fixture", transport: "http" },
    { url: "http://provider.example.invalid/live/fixture.ts", transport: "http" }];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    assert.equal(req.headers.authorization, "Bearer addon-fixture");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/addon.boss" ? {
      format: "boss-media-addon", version: 1, resources: { catalogue: `${base}/catalogue`, playback: `${base}/playback/{id}` }
    } : { resources: upstream }));
  });
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = await BossClient.fromAddon(`${base}/addon.boss`, { token: "addon-fixture" });
    const result = await client.playback("fixture");
    assert.equal(result.resources.length, 2, "an HTTP entry must not hide a valid HTTPS choice");
    for (const resource of result.resources) {
      const direct = playbackRequest(resource);
      assert.equal(direct.url, resource.url);
      assert.deepEqual(direct.headers, {}, "addon authentication never becomes media authentication");
    }
    assert.deepEqual(requests, ["/addon.boss", "/playback/fixture"], "the SDK never fetches media");
    const forbidden = BossClient.connectDescriptor({ resources: { catalogue: `${base}/catalogue`, playback: "https://untrusted.example.invalid/api/{id}" } }, new URL(`${base}/addon.boss`), "addon-fixture");
    assert.throws(() => forbidden.playback("fixture"), error => error.status === 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("native hosted and file SDK discovery preserve identity and lazy playback", async () => {
  const { createBossAddon } = await import("../public/boss-addon.mjs");
  const { BossClient } = await import("../public/boss-client.mjs");
  let handler, plays = 0;
  const server = http.createServer((req, res) => handler.emit("request", req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = "test-only-private-addon-token";
  const item = { id: "owned-1", title: "Owned fixture", type: "movie", identities: { imdb: "tt1375666" } };
  handler = createBossAddon({ id: "test.boss", name: "Fixture", baseUrl, types: ["movie"], token }, {
    catalogue: () => ({ items: [item], next: null }),
    search: () => ({ items: [item], next: null, nextOffset: null }),
    media: () => item,
    playback: () => { plays++; return [{ url: `${baseUrl}/owned.mp4`, transport: "http" }]; }
  });
  try {
    await assert.rejects(BossClient.fromAddon(`${baseUrl}/addon.boss`), error => error.status === 401);
    const response = await fetch(`${baseUrl}/addon.boss`, { headers: { Authorization: `Bearer ${token}` } });
    assert.match(response.headers.get("content-disposition"), /addon\.boss/);
    const file = await response.text();
    const hosted = await BossClient.fromAddon(`${baseUrl}/addon.boss`, { token });
    const imported = await BossClient.fromFile(file, { trustedOrigin: baseUrl, token });
    for (const client of [hosted, imported]) {
      assert.equal(client.descriptor.security.torrents, false);
      assert.equal((await client.catalogue({ type: "movie" })).items[0].id, item.id);
      assert.equal((await client.search("Owned")).items[0].id, item.id);
      assert.equal((await client.media(item.id)).media.identities.imdb, item.identities.imdb);
    }
    assert.equal(plays, 0);
    assert.equal((await hosted.playback(item.id)).resources[0].url, `${baseUrl}/owned.mp4`);
    assert.equal(plays, 1);
    assert.throws(() => hosted.guide(), error => error.status === 422);
    const forged = JSON.parse(file);
    forged.resources.catalogue = "https://unrelated.example/catalogue";
    const untrusted = await BossClient.fromFile(JSON.stringify(forged), { trustedOrigin: baseUrl, token });
    assert.throws(() => untrusted.catalogue(), error => error.status === 400);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("HTTP media policy permits resolved resources and rejects torrent mechanisms", async () => {
  const { httpMedia, allowedStreams } = require("../stream-policy");
  assert.equal(httpMedia("https://owned.example/media.mp4"), true);
  for (const url of ["magnet:?xt=urn:btih:test", "https://owned.example/file.torrent", "file:///etc/passwd"]) assert.equal(httpMedia(url), false);
  assert.equal(allowedStreams([{ url: "https://owned.example/media.mp4", infoHash: "not-allowed" }]).length, 0);
});

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

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

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");

test("selected playback tickets hide secrets, preserve bytes, and enforce expiry and revocation", async () => {
  const directory = await fs.mkdtemp("/tmp/boss-choice-ticket-");
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.DATA_DIR = directory;
  process.env.BASE_PATH = "/";
  process.env.PUBLIC_BASE_URL = base;
  process.env.BOSS_ADMIN_TOKEN = "test-only-choice-administration";
  process.env.BOSS_SECRET = "test-only-choice-encryption-secret";
  const app = require("../server");
  const headers = [];
  server.on("request", (req, res) => {
    if (req.url === "/fixture.mp4?private=credential") {
      headers.push(req.headers);
      res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 0-3/4", "Content-Length": "4" }); return res.end("BOSS");
    }
    if (req.url === "/fixture.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" }); return res.end("#EXTM3U\n#EXTINF:10,\nfixture.ts\n");
    }
    app.server.emit("request", req, res);
  });
  try {
    await app.ready;
    const graph = app.engine.graph;
    const sourceId = graph.addSource({ protocol: "xtream", name: "Owned provider", configuration: {}, capabilities: { streams: true, types: ["movie"] } });
    const mediaId = graph.ingest(sourceId, [{ type: "movie", title: "Fixture", sourceKey: "one" }])[0];
    const media = graph.media(mediaId);
    const collection = graph.createCollection({ name: "Fixture", sourceIds: [sourceId] });
    app.engine.registry.get = async () => ({ capabilities: { streams: true }, async resolve() { return [
      { url: `${base}/fixture.mp4?private=credential`, requiredHeaders: { Authorization: "Bearer fixture-secret" }, resolution: { height: 1080 } },
      { url: `${base}/fixture.m3u8`, requiredHeaders: { Authorization: "Bearer fixture-secret" } }
    ]; } });
    const endpoint = `${base}/a/${collection.id}/boss/playback/${media.canonicalId}`;
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.resources.length, 3);
    assert.doesNotMatch(JSON.stringify(body), /fixture-secret|private=credential/);
    const chosen = body.resources.find(resource => resource.mode === "selected" && resource.transport === "http");
    const playback = await fetch(chosen.url, { headers: { Range: "bytes=0-3" } });
    assert.equal(playback.status, 206);
    assert.equal(await playback.text(), "BOSS");
    assert.equal(headers[0].authorization, "Bearer fixture-secret");
    assert.equal(headers[0].range, "bytes=0-3");
    const hls = body.resources.find(resource => resource.transport === "hls");
    const playlist = await (await fetch(hls.url)).text();
    const child = playlist.split("\n").find(line => line.startsWith(base));
    const childTicket = graph.secrets.open(Buffer.from(child.split("/").at(-1), "base64url").toString());
    assert.ok(childTicket.expires > hls.expiresAt + 300000, "HLS session is not truncated by selection expiry");
    const ticket = graph.secrets.open(Buffer.from(chosen.url.split("/").at(-1), "base64url").toString());
    const expired = chosen.url.slice(0, chosen.url.lastIndexOf("/") + 1) + Buffer.from(graph.secrets.seal({ ...ticket, expires: Date.now() - 1 })).toString("base64url");
    assert.equal((await fetch(expired)).status, 403);
    const forged = chosen.url.slice(0, -8) + "AAAAAAAA";
    assert.equal((await fetch(forged)).status, 403);
    graph.updateCollection(collection.id, { ...collection, profile: { maxHeight: 720 } });
    assert.equal((await fetch(chosen.url)).status, 403);
    const fresh = await (await fetch(endpoint)).json();
    const restricted = fresh.resources.find(resource => resource.mode === "selected");
    graph.updateSource(sourceId, { configuration: { replaced: true } });
    assert.equal((await fetch(restricted.url)).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

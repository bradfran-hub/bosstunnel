"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
async function main() {
  const dir = await fs.mkdtemp("/tmp/boss-dash-video-");
  let upstream, runtime;
  const requested = new Set();
  try {
    const clip = path.join(dir, "clip.mp4");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-g", "10", "-c:a", "aac", clip]);
    await run("ffmpeg", ["-v", "error", "-i", clip, "-map", "0", "-c", "copy", "-f", "dash", "-seg_duration", "1", "-use_template", "1", "-use_timeline", "1", path.join(dir, "show.mpd")]);
    const files = new Set(await fs.readdir(dir));
    upstream = http.createServer((req, res) => {
      const name = new URL(req.url, "http://fixture").pathname.slice(1);
      if (!files.has(name)) { res.writeHead(404); return res.end(); }
      if (req.headers.authorization !== "Bearer dash-video-test") { res.writeHead(401); return res.end(); }
      requested.add(name);
      fs.readFile(path.join(dir, name)).then(data => {
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        if (start > end) { res.writeHead(416); return res.end(); }
        res.writeHead(range ? 206 : 200, { "Content-Type": name.endsWith(".mpd") ? "application/dash+xml" : "video/mp4", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, ...(range ? { "Content-Range": `bytes ${start}-${end}/${data.length}` } : {}) });
        res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
      }).catch(() => res.destroy());
    });
    await new Promise(resolve => upstream.listen(0, "0.0.0.0", resolve));
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, "0.0.0.0", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}/bossmedia`;
    Object.assign(process.env, { DATA_DIR: path.join(dir, "db"), BOSS_ADMIN_TOKEN: "dash-video-test-admin-token-long-enough", BOSS_SECRET: "dash-video-test-secret-at-least-32-characters", PUBLIC_BASE_URL: base });
    runtime = require("../server"); await runtime.ready;
    await new Promise(resolve => runtime.server.listen(port, "0.0.0.0", resolve));
    const graph = runtime.engine.graph;
    const { capabilities } = require("../core/model");
    const declaration = capabilities({ streams: true, types: ["movie"] });
    graph.addSource({ id: "dash", protocol: "fixture", name: "DASH fixture", configuration: {}, capabilities: declaration });
    const collection = graph.createCollection({ name: "DASH video test", sourceIds: ["dash"] });
    const source = `http://127.0.0.1:${upstream.address().port}/show.mpd`;
    runtime.engine.registry.register("fixture", () => ({ id: "dash", capabilities: declaration, async resolve() { return [{ url: source, protocol: "dash", requiredHeaders: { Authorization: "Bearer dash-video-test" } }]; } }));
    const [mediaId] = graph.ingest("dash", [{ sourceKey: "clip", type: "movie", title: "DASH fixture" }]);
    const { sealTicket } = require("../core/resource-ticket");
    const encoded = sealTicket(graph, collection.id, "dash", { url: source, headers: { Authorization: "Bearer dash-video-test" } }, Date.now() + 60000);
    const url = `${base}/a/${collection.id}/resource/${encoded}`;
    const { parseDash } = require("../core/dash-document");
    const { openTicket } = require("../core/resource-ticket");
    const document = parseDash(await (await fetch(url)).text());
    const resourceLinks = [];
    const collect = node => { if (typeof node !== "string") { if (node.local === "SegmentTemplate") for (const item of node.attributes) if (["media", "initialization"].includes(item.local)) resourceLinks.push(item.value); node.children.forEach(collect); } }; collect(document);
    for (const link of resourceLinks) {
      const resolved = new URL(link.replaceAll("$Number$", "1"));
      const value = openTicket(graph, collection.id, resolved.pathname.split("/").at(-1), resolved.searchParams);
      const expected = await fs.readFile(path.join(dir, new URL(value.resource.url).pathname.slice(1)));
      assert.deepEqual(Buffer.from(await (await fetch(resolved)).arrayBuffer()), expected);
    }
    assert.equal(resourceLinks.length, 4);
    const frames = async (input, seek = false) => {
      const args = ["-v", "error", ...(seek ? ["-ss", "1"] : []), "-i", input, "-map", "0:v:0", ...(seek ? ["-frames:v", "5"] : []), "-f", "framemd5", "pipe:1"];
      const { stdout } = await run("ffmpeg", args, { timeout: 30000, maxBuffer: 1048576 });
      return stdout.split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1).trim());
    };
    const expected = await frames(clip), actual = await frames(url);
    assert.equal(actual.length, 30); assert.deepEqual(actual, expected);
    assert.deepEqual(await frames(url, true), await frames(clip, true));
    const audio = async (input, seek = false, authorized = false) => {
      const args = ["-v", "error", ...(authorized ? ["-headers", "Authorization: Bearer dash-video-test\r\n"] : []), ...(seek ? ["-ss", "1"] : []), "-i", input, "-map", "0:a:0", ...(seek ? ["-t", "1"] : []), "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"];
      const { stdout } = await run("ffmpeg", args, { timeout: 30000, maxBuffer: 1048576, encoding: "buffer" });
      return stdout;
    };
    const expectedAudio = await audio(source, false, true), actualAudio = await audio(url);
    assert.ok(actualAudio.length >= 3 * 48000 * 2, "Three seconds of decoded mono audio required");
    assert.deepEqual(actualAudio, expectedAudio);
    const seekAudio = await audio(url, true);
    assert.equal(seekAudio.length, 48000 * 2);
    assert.deepEqual(seekAudio, await audio(source, true, true));
    const playback = await (await fetch(`${base}/a/${collection.id}/boss/playback/${graph.media(mediaId).canonicalId}`)).json();
    const nativeUrl = playback.resources[0].url;
    assert.equal((await fetch(nativeUrl)).status, 422, "Legacy defaults must not select declared DASH");
    for (const query of ["boss_protocols=", "boss_protocols=torrent", "boss_protocols=dash,dash", "boss_protocols=dash&boss_protocols=http"]) {
      assert.equal((await fetch(`${nativeUrl}?${query}`)).status, 400);
    }
    const optedIn = `${nativeUrl}?boss_protocols=dash`;
    assert.deepEqual(await frames(optedIn), expected);
    assert.deepEqual(await frames(optedIn, true), await frames(clip, true));
    assert.deepEqual(await audio(optedIn), expectedAudio);
    assert.deepEqual(await audio(optedIn, true), seekAudio);
    const playlist = await (await fetch(`${base}/a/${collection.id}/playlist.m3u`)).text();
    const playlistUrl = playlist.split(/\r?\n/).find(line => line && !line.startsWith("#"));
    assert.ok(new URL(playlistUrl).pathname.includes("/xtream/movie/"));
    assert.equal((await fetch(playlistUrl)).status, 422);
    const xtreamUrl = new URL(playlistUrl);
    xtreamUrl.searchParams.set("boss_protocols", "dash");
    assert.deepEqual(await frames(xtreamUrl.href), expected);
    assert.deepEqual(await frames(xtreamUrl.href, true), await frames(clip, true));
    assert.deepEqual(await audio(xtreamUrl.href), expectedAudio);
    assert.deepEqual(await audio(xtreamUrl.href, true), seekAudio);
    const { BossClient } = await import("../public/boss-client.mjs");
    const parts = xtreamUrl.pathname.split("/");
    const clients = [
      ["native", await BossClient.fromAddon(`${base}/a/${collection.id}/addon.boss`)],
      ["m3u", await BossClient.fromM3u(`${base}/a/${collection.id}/playlist.m3u`)],
      ["xtream", await BossClient.fromXtream(`${base}/xtream`, parts.at(-3), parts.at(-2))]
    ];
    for (const [mode, client] of clients) {
      const response = await client.playback(graph.media(mediaId).canonicalId, { protocols: ["dash"] });
      const link = response.resources[0].url;
      assert.equal(new URL(link).searchParams.get("boss_protocols"), "dash", `${mode} must preserve negotiation`);
      assert.deepEqual(await frames(link), expected, `${mode} SDK video`);
      assert.deepEqual(await audio(link), expectedAudio, `${mode} SDK audio`);
    }
    assert.ok([...requested].some(name => name.endsWith(".m4s")));
    assert.equal((await fetch(source)).status, 401);
    const report = { frames: actual.length, identicalDecodedFrames: true, seekFrames: 5, identicalDecodedAudio: true, audioSamples: actualAudio.length / 2, seekAudioSamples: seekAudio.length / 2, audioBaseline: "authorized upstream DASH", mediaBytesUnchanged: true, byteCheckedResources: resourceLinks.length, authenticatedResources: requested.size, routes: ["encrypted MPD resource ticket", "native playback via canonical resolver", "M3U-discovered Xtream movie via canonical resolver"], sdkConnections: clients.map(([mode]) => mode), resolverEnabled: "explicit boss_protocols=dash only", legacyDefaultsExcludeDash: true };
    await fs.mkdir(path.join(__dirname, "../artifacts"), { recursive: true });
    await fs.writeFile(path.join(__dirname, "../artifacts/dash-playback.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (runtime) { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); await runtime.close(); }
    if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message.replace(/https?:\/\/\S+/g, "[resource URL]")); process.exitCode = 1; });

"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { once } = require("node:events");
const { jsonValues, lines } = require("../sources/transport");
const count = Number(process.env.SCALE_ITEMS || 100000);
assert.ok(Number.isSafeInteger(count) && count >= 1000);
async function main() {
  const dir = await fs.mkdtemp("/tmp/boss-pipeline-scale-");
  process.env.DATA_DIR = dir;
  process.env.BOSS_ADMIN_TOKEN = "pipeline-test-admin-token-long-enough";
  process.env.BOSS_SECRET = "pipeline-test-encryption-secret-long-enough";
  process.env.PUBLIC_BASE_URL = "http://pipeline.test/bossmedia";
  let catalogueRequests = 0, playbackRequests = 0;
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, "http://test");
    if (url.pathname.startsWith("/movie/")) { playbackRequests++; res.setHeader("Content-Type", "video/mp4"); return res.end("authorized-media"); }
    const action = url.searchParams.get("action");
    res.setHeader("Content-Type", "application/json");
    if (!action) return res.end('{"user_info":{"auth":1,"status":"Active"}}');
    if (action !== "get_vod_streams") return res.end("[]");
    catalogueRequests++;
    (async () => {
      res.write("[");
      for (let id = 1; id <= count; id++) {
        if (res.destroyed) return;
        const row = JSON.stringify({ stream_id: id, name: `Scale Film ${id}`, container_extension: "mp4" });
        if (!res.write((id === 1 ? "" : ",") + row)) await once(res, "drain");
      }
      res.end("]");
    })().catch(() => res.destroy());
  });
  const runtime = require("../server");
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
  const started = Date.now();
  try {
    await new Promise((resolve) => mock.listen(0, "0.0.0.0", resolve));
    await runtime.ready;
    await new Promise((resolve) => runtime.server.listen(0, "0.0.0.0", resolve));
    const base = `http://127.0.0.1:${runtime.server.address().port}/bossmedia`;
    const local = (url) => url.replace("http://pipeline.test/bossmedia", base);
    const headers = { "X-Boss-Admin": process.env.BOSS_ADMIN_TOKEN, "Content-Type": "application/json" };
    const response = await fetch(`${base}/api/addons`, { method: "POST", headers, body: JSON.stringify({ sourceType: "xtream", name: "Scale library", baseUrl: `http://127.0.0.1:${mock.address().port}`, username: "authorized", password: "private-source-password" }) });
    assert.equal(response.status, 201);
    const { addon } = await response.json();
    let source;
    while (Date.now() - started < 240000) {
      source = (await (await fetch(`${base}/api/addons`, { headers })).json()).addons[0];
      if (!source.syncing) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(source.sync.status, "complete", JSON.stringify(source.sync));
    assert.equal(source.jobs.reduce((sum, job) => sum + job.imported_count, 0), count);
    assert.equal(catalogueRequests, 1);
    assert.equal(playbackRequests, 0);
    const ingestionMs = Date.now() - started;
    const auth = new URLSearchParams({ username: addon.id, password: addon.xtream.password });
    const endpoint = `${local(addon.xtream.server)}/player_api.php?${auth}&action=get_vod_streams`;
    let received = 0, first, last;
    for await (const row of jsonValues(endpoint)) { received++; first ||= row; last = row; }
    assert.equal(received, count);
    assert.notEqual(first.stream_id, last.stream_id);
    assert.equal(catalogueRequests, 1, "export cannot replay source catalogue");
    assert.equal(playbackRequests, 0, "export cannot resolve streams");
    let entries = 0;
    for await (const line of lines((await fetch(local(addon.playlistUrl))).body)) if (line.startsWith("#EXTINF:")) entries++;
    assert.equal(entries, count);
    for (const row of [first, last]) assert.equal(await (await fetch(local(row.direct_source))).text(), "authorized-media");
    assert.equal(playbackRequests, 2);
    assert.equal(catalogueRequests, 1);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    assert.ok(peakRss < 400 * 1024 * 1024, `Peak RSS ${peakRss} exceeds the production memory budget`);
    const report = { items: count, ingestionMs, totalMs: Date.now() - started, initialRss, peakRss, catalogueRequests, playbackRequests, xtreamRows: received, playlistRows: entries };
    await fs.mkdir(path.join(__dirname, "../artifacts"), { recursive: true });
    await fs.writeFile(path.join(__dirname, "../artifacts/pipeline-scale.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    clearInterval(sample);
    runtime.server.closeAllConnections();
    await new Promise((resolve) => runtime.server.close(resolve));
    await runtime.close();
    mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

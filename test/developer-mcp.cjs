"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { createDeveloperMcp, validateDescriptor } = require("../core/developer-mcp");

test("official MCP client reads public docs, tools, resources and prompts without private access", async () => {
  let handler;
  const httpServer = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  handler = createDeveloperMcp({ publicUrl: origin });
  const client = new Client({ name: "boss-fixture", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + "/mcp")));
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(t => t.name).sort(), ["boss_docs", "boss_search_docs", "boss_validate_descriptor"]);
    assert.ok(list.tools.every(t => t.annotations.readOnlyHint));
    const first = JSON.parse((await client.callTool({ name: "boss_docs", arguments: { document: "protocol", limit: 120 } })).content[0].text);
    assert.equal(first.text.length, 120); assert.equal(first.nextOffset, 120);
    const second = JSON.parse((await client.callTool({ name: "boss_docs", arguments: { document: "protocol", offset: 120, limit: 120 } })).content[0].text);
    assert.notEqual(first.text, second.text);
    const sdk = await client.readResource({ uri: "boss://docs/app_sdk" });
    assert.match(sdk.contents[0].text, /class BossClient/);
    assert.equal((await client.listResources()).resources.length, 7);
    assert.ok((await client.getPrompt({ name: "integrate_boss", arguments: { target: "app" } })).messages.length);
    assert.equal((await client.callTool({ name: "boss_docs", arguments: { document: "../.env" } })).isError, true);
    const search = JSON.parse((await client.callTool({ name: "boss_search_docs", arguments: { query: "canonical" } })).content[0].text);
    assert.ok(search.matches.length);
    const invalid = JSON.parse((await client.callTool({ name: "boss_validate_descriptor", arguments: { descriptor: {} } })).content[0].text);
    assert.equal(invalid.validStructure, false); assert.equal(invalid.playbackVerified, false);
    for (const [headers, body, status] of [
      [{ Origin: "https://untrusted.example", "Content-Type": "application/json" }, "{}", 403],
      [{ "Content-Type": "text/plain" }, "{}", 415],
      [{ "Content-Type": "application/json" }, "not valid", 400],
      [{ "Content-Type": "application/json" }, "[]", 400],
      [{ "Content-Type": "application/json" }, " ".repeat(32769), 413]
    ]) { const r = await fetch(origin + "/mcp", { method: "POST", headers, body }); assert.equal(r.status, status); await r.body.cancel(); }
    const get = await fetch(origin + "/mcp"); assert.equal(get.status, 405); await get.body.cancel();
    const methods = await client.listTools(); assert.equal(methods.tools.length, 3);
  } finally {
    await client.close(); httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
  }
});

test("offline descriptor checks reject cross-origin and torrent resources without echoing values", () => {
  const descriptor = { format: "boss-media-addon", version: 1, id: "example", name: "Example", addonUrl: "https://example.invalid/addon.boss", capabilities: { catalog: true, streams: true, types: ["movie"] }, resources: { catalogue: "https://example.invalid/catalogue", playback: "https://example.invalid/playback/{id}" }, security: { torrents: false } };
  assert.equal(validateDescriptor(descriptor).validStructure, true);
  for (const url of ["https://unrelated.invalid/private-token", "https://example.invalid/file.torrent"]) {
    const result = validateDescriptor({ ...descriptor, resources: { ...descriptor.resources, playback: url } });
    assert.equal(result.validStructure, false);
    assert.ok(!JSON.stringify(result).includes(url));
  }
  for (const patch of [
    { capabilities: { catalog: true } },
    { capabilities: { ...descriptor.capabilities, epg: true } },
    { resources: { playback: descriptor.resources.playback } },
    { capabilities: { ...descriptor.capabilities, types: ["channel"], catchup: true } }
  ]) assert.equal(validateDescriptor({ ...descriptor, ...patch }).validStructure, false);
});

test("MCP bounds concurrent bodies, releases disconnected requests and resets rate limits", async () => {
  const { setTimeout: delay } = require("node:timers/promises");
  let handler, now = 0;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createDeveloperMcp({ publicUrl: origin, timeoutMs: 200, maxConcurrent: 1, maxRequestsPerMinute: 3, clock: () => now });
  const post = () => fetch(origin, { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" });
  const slow = () => {
    const req = http.request(origin, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "100" } });
    req.on("error", () => {}); req.flushHeaders(); req.write("{"); return req;
  };
  try {
    const first = slow();
    await delay(30);
    const busy = await post(); assert.equal(busy.status, 429); assert.equal(busy.headers.get("retry-after"), "60"); await busy.body.cancel();
    first.destroy(); await delay(30);
    const freed = await post(); assert.equal(freed.status, 400); await freed.body.cancel();
    const stalled = slow(); await delay(300);
    assert.equal(stalled.destroyed, true);
    now = 60000;
    const reset = await post(); assert.equal(reset.status, 400); await reset.body.cancel();
    const hostileStatus = await new Promise((resolve, reject) => {
      const req = http.request(origin, { method: "POST", headers: { Host: "untrusted.invalid", "X-Forwarded-Host": new URL(origin).host } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject); req.end();
    });
    assert.equal(hostileStatus, 403);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

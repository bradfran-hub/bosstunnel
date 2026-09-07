"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseDash, serializeDash, namespace } = require("../core/dash-document");
const document = body => `<MPD xmlns="${namespace}" type="static">${body}</MPD>`;
test("app SDK validates advertised protocol negotiation without changing legacy requests", async () => {
  const { BossClient } = await import("../public/boss-client.mjs");
  const calls = [];
  const invoke = (...args) => { calls.push(args); return {}; };
  const legacy = new BossClient({}, invoke);
  legacy.playback("movie");
  assert.deepEqual(calls.pop()[1], { id: "movie" });
  assert.throws(() => legacy.playback("movie", { protocols: ["dash"] }), { status: 422 });
  const client = new BossClient({ playbackNegotiation: { parameter: "boss_protocols", protocols: ["http", "hls", "dash"] } }, invoke);
  const signal = new AbortController().signal;
  client.playback("movie", { protocols: ["http", "dash"], signal });
  assert.deepEqual(calls.pop(), ["playback", { id: "movie", boss_protocols: "http,dash" }, { signal }]);
  client.catchup("channel", { start: 10, end: 20, protocols: ["hls"] });
  assert.deepEqual(calls.pop()[1], { id: "channel", start: 10, end: 20, boss_protocols: "hls" });
  for (const protocols of [[], "dash", ["torrent"], ["dash", "dash"], [null]]) {
    assert.throws(() => client.playback("movie", { protocols }), { status: 400 });
  }
  assert.equal(calls.length, 0, "Invalid negotiation must not issue a request");
});
test("playback protocols require explicit bounded client opt-in and preserve legacy defaults", () => {
  const { playbackProtocols } = require("../core/playback-context");
  assert.deepEqual(playbackProtocols(new URLSearchParams()), ["http", "hls"]);
  for (const value of ["http", "hls", "dash", "http,hls,dash", "dash,http"]) {
    assert.deepEqual(playbackProtocols(new URLSearchParams({ boss_protocols: value })), value.split(","));
  }
  for (const value of ["", "torrent", "DASH", "dash,dash", "http,hls,dash,http", "dash,", " dash", "https://example.com"]) {
    assert.throws(() => playbackProtocols(new URLSearchParams({ boss_protocols: value })), { status: 400 });
  }
  assert.throws(() => playbackProtocols(new URLSearchParams("boss_protocols=dash&boss_protocols=http")), { status: 400 });
});
test("DASH rewriting materializes inherited addressing and isolates cross-origin credentials", () => {
  const { rewriteDash } = require("../core/dash-rewrite");
  const { resolveTemplate, templateQuery } = require("../core/dash-template");
  const issued = [];
  const output = rewriteDash(document('<BaseURL>https://media.example/assets/</BaseURL><Period><BaseURL>season/</BaseURL><AdaptationSet><SegmentTemplate timescale="1000" initialization="init-$RepresentationID$.mp4" media="seg-$Number%05d$.m4s"><SegmentTimeline><S t="0" d="1000" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="video" bandwidth="500"><SegmentTemplate startNumber="3"/></Representation><Representation id="audio" bandwidth="100"><BaseURL>https://cdn.example/audio/</BaseURL></Representation></AdaptationSet></Period>'), "https://media.example/show.mpd", {
    headers: { Authorization: "Bearer private-token" }, ticket(resource) { issued.push(resource); const query = resource.dashTemplate ? templateQuery(resource.dashTemplate) : ""; return `https://boss.example/resource/${issued.length}${query ? `?${query}` : ""}`; }
  });
  assert.ok(!output.includes("media.example") && !output.includes("cdn.example") && !output.includes("private-token"));
  const parsed = parseDash(output);
  const nodes = [];
  const visit = node => { if (typeof node !== "string") { nodes.push(node); node.children.forEach(visit); } }; visit(parsed);
  assert.equal(nodes.filter(node => node.local === "SegmentTemplate").length, 2);
  assert.equal(nodes.filter(node => node.local === "SegmentTimeline").length, 2);
  assert.ok(output.includes('startNumber="3"'));
  assert.equal(resolveTemplate(issued[0].dashTemplate, new URLSearchParams({ Number: "3" })), "https://media.example/assets/season/seg-00003.m4s");
  assert.equal(issued[0].headers.Authorization, "Bearer private-token");
  assert.equal(resolveTemplate(issued[1].dashTemplate, new URLSearchParams()), "https://media.example/assets/season/init-video.mp4");
  assert.deepEqual(issued[2].headers, {});
  assert.equal(resolveTemplate(issued[2].dashTemplate, new URLSearchParams({ Number: "3" })), "https://cdn.example/audio/seg-00003.m4s");
});
test("DASH rewriting preserves list and single-file ranges without exposing original URLs", () => {
  const { rewriteDash } = require("../core/dash-rewrite");
  const issued = [];
  const output = rewriteDash(document('<Period><AdaptationSet><Representation id="list"><BaseURL>file.mp4</BaseURL><SegmentList timescale="10"><Initialization range="0-99"/><SegmentURL mediaRange="100-999" index="index.bin" indexRange="0-50"/></SegmentList></Representation><Representation id="base"><BaseURL>single.mp4</BaseURL><SegmentBase indexRange="100-200"><Initialization range="0-99"/></SegmentBase></Representation></AdaptationSet></Period>'), "https://media.example/show.mpd", { ticket(resource) { issued.push(resource); return `https://boss.example/resource/${issued.length}`; } });
  assert.ok(output.includes('mediaRange="100-999"') && output.includes('indexRange="100-200"') && output.includes('range="0-99"'));
  assert.ok(!output.includes("media.example"));
  assert.deepEqual(issued.map(item => item.url), ["https://media.example/file.mp4", "https://media.example/index.bin", "https://media.example/file.mp4", "https://media.example/single.mp4", "https://media.example/single.mp4"]);
  parseDash(output);
});
test("DASH rewriting fails explicitly for unsupported addressing and bounded expansion", () => {
  const { rewriteDash } = require("../core/dash-rewrite");
  const options = { ticket: () => "https://boss.example/resource/example" };
  const base = "https://media.example/show.mpd";
  for (const body of ['<BaseURL>a/</BaseURL><BaseURL>b/</BaseURL><Period/>', '<Period><AdaptationSet><Representation><SegmentBase/></Representation></AdaptationSet></Period>', '<Period xml:base="https://private.example/"/>', '<UTCTiming/><Period/>']) assert.throws(() => rewriteDash(document(body), base, options), { code: "UNSUPPORTED_DASH" });
  const simple = document('<Period><AdaptationSet><Representation><SegmentTemplate media="seg-$Number$.m4s" initialization="init.mp4"/></Representation></AdaptationSet></Period>');
  assert.throws(() => rewriteDash(simple, base, { ...options, maxResources: 1 }), /resource count/);
  assert.throws(() => rewriteDash(simple, base, { ...options, maxOutputBytes: 10 }), /size limit/);
});
test("encrypted DASH resource tickets bind templates, credentials, expiry and authorization revisions", () => {
  const { MediaGraph } = require("../core/graph");
  const { sealTicket, openTicket } = require("../core/resource-ticket");
  const { compileTemplate } = require("../core/dash-template");
  let now = Date.now();
  const graph = new MediaGraph(":memory:", { secret: "dash-ticket-test-secret-at-least-32-characters", clock: () => now });
  try {
    graph.addSource({ id: "source", protocol: "fixture", name: "Source", configuration: {} });
    const library = graph.createCollection({ name: "Library", sourceIds: ["source"] });
    const resource = { dashTemplate: compileTemplate("seg-$Number%05d$.m4s", "https://media.example/private/"), headers: { Authorization: "Bearer private-key" } };
    const ticket = sealTicket(graph, library.id, "source", resource, now + 1000);
    const [encoded, query] = ticket.split("?");
    assert.equal(query, "Number=$Number$");
    assert.ok(!Buffer.from(encoded, "base64url").toString().includes("private"));
    const params = new URLSearchParams({ Number: "7" });
    const opened = openTicket(graph, library.id, encoded, params);
    assert.equal(opened.resource.url, "https://media.example/private/seg-00007.m4s");
    assert.equal(opened.resource.headers.Authorization, "Bearer private-key");
    assert.throws(() => openTicket(graph, library.id, encoded, new URLSearchParams("Number=1&url=https://other.example")), { code: "INVALID_DASH_TEMPLATE" });
    assert.throws(() => openTicket(graph, "another-library", encoded, params), { status: 403 });
    graph.sql("UPDATE Sources SET revision=revision+1 WHERE id='source'").run();
    assert.throws(() => openTicket(graph, library.id, encoded, params), { status: 403 });
    graph.sql("UPDATE Sources SET revision=revision-1 WHERE id='source'").run();
    graph.sql("UPDATE CollectionRevisions SET revision=revision+1 WHERE collection_id=?").run(library.id);
    assert.throws(() => openTicket(graph, library.id, encoded, params), { status: 403 });
    graph.sql("UPDATE CollectionRevisions SET revision=revision-1 WHERE collection_id=?").run(library.id);
    now += 1001;
    assert.throws(() => openTicket(graph, library.id, encoded, params), { status: 403 });
    assert.throws(() => sealTicket(graph, library.id, "source", resource, now - 1), { status: 403 });
  } finally { graph.close(); }
});
test("DASH templates bind representation values and preserve integer formatting across serialization", () => {
  const { compileTemplate, resolveTemplate, templateQuery } = require("../core/dash-template");
  const compiled = compileTemplate("$RepresentationID$/$Bandwidth$/seg-$Number%05d$-$Time$-$$.m4s", "https://media.example/path/", { id: "video/main", bandwidth: 500000 });
  assert.equal(templateQuery(compiled), "Number=$Number$&Time=$Time$");
  const restored = JSON.parse(JSON.stringify(compiled));
  assert.equal(resolveTemplate(restored, new URLSearchParams({ Number: "12", Time: "18446744073709551615" })), "https://media.example/path/video%2Fmain/500000/seg-00012-18446744073709551615-$.m4s");
  const init = compileTemplate("init-$RepresentationID$.mp4", "https://media.example/path/", { id: "video" });
  assert.equal(templateQuery(init), "");
  assert.equal(resolveTemplate(init, new URLSearchParams()), "https://media.example/path/init-video.mp4");
});
test("DASH template substitutions reject arbitrary endpoints, duplicate parameters and numeric overflow", () => {
  const { compileTemplate, resolveTemplate } = require("../core/dash-template");
  const base = "https://media.example/path/";
  for (const template of ["$Unknown$.m4s", "$Number%099d$.m4s", "https://$Number$.example/seg.m4s", "http://user:pass@example/seg.m4s", "magnet:bad", "file.torrent", "seg-$Number$.m4s#fragment"]) assert.throws(() => compileTemplate(template, base), { code: "INVALID_DASH_TEMPLATE" });
  assert.throws(() => compileTemplate("$Bandwidth$.m4s", base, { bandwidth: Number.MAX_SAFE_INTEGER + 1 }), { code: "INVALID_DASH_TEMPLATE" });
  const compiled = compileTemplate("seg-$Number$.m4s", base);
  for (const query of ["", "Number=1&Number=2", "Number=../secret", "Number=-1", "Number=1.5", "Number=1e6", "Number=18446744073709551616", "Number=1&url=https://other.example", "RepresentationID=other&Number=1"]) assert.throws(() => resolveTemplate(compiled, new URLSearchParams(query)), { code: "INVALID_DASH_TEMPLATE" });
});
test("DASH parser preserves namespaces, template variables, timelines and escaped URLs", () => {
  const text = document('<BaseURL>https://media.example/path/?a=1&amp;b=2</BaseURL><Period id="p"><AdaptationSet><SegmentTemplate media="seg-$RepresentationID$-$Number%05d$.m4s" initialization="init-$RepresentationID$.mp4"><SegmentTimeline><S t="0" d="1000" r="5"/></SegmentTimeline></SegmentTemplate><Representation id="video" bandwidth="500000"/></AdaptationSet></Period>');
  const parsed = parseDash(text);
  assert.deepEqual(parseDash(serializeDash(parsed)), parsed);
  assert.equal(parsed.children[0].children[0], "https://media.example/path/?a=1&b=2");
  assert.ok(serializeDash(parsed).includes("$Number%05d$"));
  const prefixed = parseDash(`<d:MPD xmlns:d="${namespace}"><d:Period/></d:MPD>`);
  assert.equal(prefixed.namespace, namespace);
  assert.deepEqual(parseDash(serializeDash(prefixed)), prefixed);
  const whitespace = parseDash(document('<Period id="a&#10;b&#9;c&#13;d"/>'));
  assert.deepEqual(parseDash(serializeDash(whitespace)), whitespace);
});
test("DASH parser rejects protected content, external entities and remote XML fragments", () => {
  for (const text of [
    document('<Period><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/></AdaptationSet></Period>'),
    `<!DOCTYPE MPD [<!ENTITY resource SYSTEM "https://private.example/secret">]>${document("&resource;")}`,
    document('<Period xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://private.example/fragment"/>'),
    document("&unknown;")
  ]) assert.throws(() => parseDash(text), error => error.code === "INVALID_DASH" && error.status === 422 && !error.message.includes("private.example"));
});
test("DASH parser rejects malformed roots and bounds bytes, nodes and depth", () => {
  for (const text of ["", "<MPD/>", document("") + document(""), document("<Period>"), "<html>Not media</html>"]) assert.throws(() => parseDash(text), { code: "INVALID_DASH" });
  assert.throws(() => parseDash(document("small"), { maxBytes: 4 }), /size limit/);
  assert.throws(() => parseDash(document("<Period><AdaptationSet/></Period>"), { maxDepth: 2 }), /structure limit/);
  assert.throws(() => parseDash(document("<Period/><Period/>"), { maxNodes: 2 }), /structure limit/);
});

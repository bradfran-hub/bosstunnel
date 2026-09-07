"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MediaEngine } = require("../core/engine");
const { OutputLibrary } = require("../protocols/library");
const { createBossOutput } = require("../protocols/boss");
const { normalizeCandidate } = require("../core/resolver");

test("BOSS lists all providers and same-provider variants without catalogue-time resolution", async () => {
  const engine = new MediaEngine(":memory:", { secret: "test-only-choice-encryption-secret" });
  const graph = engine.graph;
  const protocols = ["xtream", "addon", "plex", "emby", "jellyfin"];
  let calls = 0;
  const tickets = [];
  try {
    for (const protocol of protocols) {
      graph.addSource({ id: protocol, protocol, name: `Provider ${protocol}`, configuration: {}, capabilities: { catalog: true, streams: true, types: ["movie", "series"], identityNamespaces: ["imdb"] } });
      graph.ingest(protocol, [{ type: "movie", title: "Fixture", sourceKey: "first", externalIDs: { imdb: "tt1375666" } }]);
    }
    graph.ingest("xtream", [{ type: "movie", title: "Fixture", sourceKey: "second", externalIDs: { imdb: "tt1375666" } }]);
    const collection = graph.createCollection({ name: "Merged", sourceIds: protocols });
    const media = engine.page({ sourceIds: protocols, limit: 10 })[0];
    engine.registry.get = async sourceId => ({ capabilities: { streams: true }, resolutionTtlMs: 30000,
      async resolve(item, mapping) {
        calls++;
        const count = sourceId === "addon" ? 10 : 1;
        return [...Array.from({ length: count }, (_, index) => ({
          url: `https://owned.example/${sourceId}/${mapping.sourceKey}/${index}.mp4?token=private-fixture`,
          name: "Provider 4K", title: "WEB-DL HEVC HDR10", requiredHeaders: { Authorization: "Bearer private-fixture" },
          audio: [{ codec: "eac3", channels: 6 }], languages: ["en"]
        })), { url: "https://owned.example/not-allowed.mp4", infoHash: "forbidden" }];
      }
    });
    const library = new OutputLibrary(engine, collection, {
      play: item => `https://boss.example/play/${item.canonicalId}`,
      artwork: () => "",
      choice(item, candidate, expires) { tickets.push({ candidate, expires }); return `https://boss.example/protected/${tickets.length}`; }
    });
    const output = createBossOutput(library, "https://boss.example/a/test");
    await output.catalogue(new URLSearchParams());
    assert.equal(calls, 0);
    const result = await output.playback(media.canonicalId);
    const choices = result.resources.filter(resource => resource.mode === "selected");
    assert.equal(result.resources[0].mode, "automatic");
    assert.equal(choices.length, 15);
    assert.deepEqual(new Set(choices.map(choice => choice.source.protocol)), new Set(protocols));
    assert.equal(choices.filter(choice => choice.source.protocol === "xtream").length, 2);
    assert.equal(choices.filter(choice => choice.source.protocol === "addon").length, 10);
    assert.ok(choices.every(choice => ["2160p", "WEB-DL", "HEVC", "HDR10", "EAC3", "en"].every(tag => choice.tags.includes(tag))));
    assert.doesNotMatch(JSON.stringify(result), /private-fixture|owned\.example|Authorization|infoHash/);
    assert.ok(tickets.every(ticket => ticket.expires <= Date.now() + 300000));
    assert.equal(calls, 6);
    await output.playback(media.canonicalId);
    assert.equal(calls, 6, "source mappings use independent cached results");
    await assert.rejects(output.playback(media.canonicalId, new URLSearchParams("boss_max_height=720")), error => error.status === 422);
    graph.updateSource("plex", { enabled: false });
    assert.ok((await output.playback(media.canonicalId)).resources.every(choice => choice.source?.protocol !== "plex"));
    const series = graph.ingest("xtream", [{ type: "series", title: "Series", sourceKey: "series" }])[0];
    assert.deepEqual((await output.playback(graph.media(series).canonicalId)).resources, []);
  } finally { await engine.close(); }
});

test("quality extraction is optional, credential-free and survives normalization", () => {
  const candidate = normalizeCandidate({ url: "https://owned.example/media.mp4", name: "4K", title: "WEB-DL x265 Dolby Vision", audio: [null, { codec: "aac" }] }, "test");
  assert.equal(candidate.resolution.height, 2160);
  assert.equal(candidate.codec, "hevc");
  assert.equal(candidate.hdr, "Dolby Vision");
  assert.deepEqual(normalizeCandidate(candidate, "test"), candidate);
  const unknown = normalizeCandidate({ url: "https://owned.example/media.mp4", name: "Untitled" }, "test");
  assert.equal(unknown.quality, null);
  assert.equal(unknown.resolution, null);
  assert.equal(normalizeCandidate({ url: "https://owned.example/media.mp4", expiresAt: Date.now() - 1000 }, "test"), null);
});

test("resolver retains more than 200 choices and identical resources from distinct providers", async () => {
  const engine = new MediaEngine(":memory:", { secret: "test-only-more-choices-encryption" });
  try {
    for (const id of ["one", "two"]) {
      engine.graph.addSource({ id, protocol: "addon", name: id, configuration: {}, capabilities: { streams: true, types: ["movie"] } });
      engine.graph.ingest(id, [{ type: "movie", sourceKey: "movie", title: "Fixture", externalIDs: { imdb: "tt1375666" } }]);
    }
    engine.registry.get = async () => ({ capabilities: { streams: true }, async resolve() {
      return Array.from({ length: 205 }, (_, index) => ({ url: `https://owned.example/${index}.mp4` }));
    } });
    const media = engine.page({ sourceIds: ["one", "two"], limit: 1 })[0];
    const result = await engine.resolve(media.id, { allowedSourceIds: ["one", "two"] });
    assert.equal(result.candidates.length, 410);
  } finally { await engine.close(); }
});

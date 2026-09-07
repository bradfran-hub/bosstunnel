"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { capabilityDescriptor, parseCapabilities, capabilityQuery } = require("../core/player-capabilities");

test("player capability parameters validate, normalize and do not serialize library policy", () => {
  const params = new URLSearchParams({ boss_codecs: "h264,hevc", boss_max_height: "1080", boss_hdr: "false", boss_strict: "true", boss_language: "en-US" });
  assert.deepEqual(parseCapabilities(params), { codecs: ["h264", "hevc"], maxHeight: 1080, hdr: false, strictCapabilities: true, language: "en-us" });
  assert.deepEqual(capabilityQuery(params, { codecs: ["h264"], maxHeight: 720 }),
    { boss_codecs: "h264,hevc", boss_max_height: "1080", boss_hdr: "false", boss_strict: "true", boss_language: "en-us" });
  assert.deepEqual(capabilityQuery(new URLSearchParams(), { codecs: ["hevc"], maxHeight: 720 }), {});
  assert.deepEqual(parseCapabilities(new URLSearchParams("boss_max_height=0")), { maxHeight: 0 });
  for (const value of ["boss_codecs=", "boss_codecs=bogus", "boss_codecs=h264,h264", "boss_codecs=h264&boss_codecs=hevc",
    "boss_max_height=8641", "boss_max_height=-1", "boss_max_height=1.5", "boss_max_height=1e3", "boss_hdr=0", "boss_hdr=true&boss_hdr=false", "boss_strict=TRUE", "boss_language=english"]) {
    assert.throws(() => parseCapabilities(new URLSearchParams(value)), { status: 400 }, value);
  }
  assert.throws(() => capabilityQuery(new URLSearchParams("boss_codecs=hevc"), { codecs: ["h264"] }), { status: 422 });
  const descriptor = capabilityDescriptor(); descriptor.codecs.length = 0; descriptor.parameters.hdr = "forged";
  assert.ok(capabilityDescriptor().codecs.includes("h264"));
  assert.equal(capabilityDescriptor().parameters.hdr, "boss_hdr");
});

test("app SDK requires advertised player capabilities and keeps legacy calls unchanged", async () => {
  const { BossClient } = await import("../public/boss-client.mjs");
  const calls = [];
  const invoke = (...args) => { calls.push(args); return Promise.resolve({ resources: [] }); };
  const legacy = new BossClient({}, invoke);
  await legacy.playback("film");
  assert.deepEqual(calls.pop()[1], { id: "film" });
  assert.throws(() => legacy.playback("film", { capabilities: { hdr: false } }), { status: 422 });
  const client = new BossClient({ playbackCapabilities: capabilityDescriptor() }, invoke);
  const capabilities = { codecs: ["h264"], maxHeight: 1080, hdr: false, strictCapabilities: true, language: "en-US" };
  const signal = new AbortController().signal;
  await client.playback("film", { capabilities, signal });
  assert.deepEqual(calls.pop(), ["playback", { id: "film", boss_codecs: "h264", boss_max_height: "1080", boss_hdr: "false", boss_strict: "true", boss_language: "en-us" }, { signal }]);
  await client.catchup("channel", { capabilities, start: 1, end: 2 });
  assert.deepEqual(calls.pop()[1], { id: "channel", start: 1, end: 2, boss_codecs: "h264", boss_max_height: "1080", boss_hdr: "false", boss_strict: "true", boss_language: "en-us" });
  assert.equal(capabilities.language, "en-US");
  for (const value of [null, [], { codecs: [] }, { codecs: ["h264", "h264"] }, { codecs: ["invalid"] }, { hdr: "false" }, { maxHeight: "720" }, { maxHeight: 8641 }, { strictCapabilities: null }, { language: "english" }, { allowedSourceIds: ["excluded"] }]) {
    assert.throws(() => client.playback("film", { capabilities: value }), { status: 400 });
  }
  const partial = new BossClient({ playbackCapabilities: { ...capabilityDescriptor(), codecs: ["h264"], maximumHeight: 720 } }, invoke);
  assert.throws(() => partial.playback("film", { capabilities: { codecs: ["hevc"] } }), { status: 422 });
  assert.throws(() => partial.playback("film", { capabilities: { maxHeight: 1080 } }), { status: 422 });
  assert.equal(calls.length, 0, "Invalid/unsupported requests must not contact the server");
});

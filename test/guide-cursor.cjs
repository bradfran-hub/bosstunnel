"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { xmltv } = require("../protocols/m3u");
const { MediaEngine } = require("../core/engine");

test("guide export uses indexed ID traversal without a repeated full-guide sort", async () => {
  const engine = new MediaEngine(":memory:", { secret: "guide-cursor-test-only-secret-value" });
  let yielded = false, calls = 0;
  setImmediate(() => { yielded = true; });
  try {
    const library = {
      async *items() {},
      collection: { sourceIds: ["test"] },
      engine: { synthetic: () => 1 },
      graph: { sql(query) {
        const plan = engine.graph.sql("EXPLAIN QUERY PLAN " + query).all(0, "[]").map(row => row.detail);
        assert.ok(plan.some(line => /INTEGER PRIMARY KEY.*rowid>/.test(line)));
        assert.ok(plan.every(line => !/TEMP B-TREE/.test(line)));
        return { all() {
          if (calls++) { assert.equal(yielded, true); return []; }
          return [{ id: 1, channel_id: "test-channel", starts_at: 0, ends_at: 60000, title: "A & B", description: "Fixture" }];
        } };
      } }
    };
    let text = "";
    for await (const chunk of xmltv(library)) text += chunk;
    assert.match(text, /<programme channel="1"/);
    assert.match(text, /A &amp; B/);
    assert.equal(calls, 2);
  } finally { engine.close(); }
});

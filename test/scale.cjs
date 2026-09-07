"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
const { MediaGraph } = require("../core/graph");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-scale-"));
const filename = path.join(directory, "graph.db");
const movies = Number(process.env.BOSS_SCALE_ITEMS || 100000);
const series = Number(process.env.BOSS_SCALE_SERIES || 0);
assert.ok(Number.isSafeInteger(movies) && movies >= 1000 && Number.isSafeInteger(series) && series >= 0);
const count = movies + series;
const secret = "scale-test-stable-encryption-secret-32chars";
const started = performance.now();
let db;
let maxRss = process.memoryUsage().rss;
const initialRss = maxRss;
try {
  db = new MediaGraph(filename, { secret });
  db.addSource({ id: "scale", name: "Scale fixture", protocol: "fixture", configuration: {}, capabilities: { catalog: true, types: ["movie", "series"] } });
  for (let start = 0; start < count; start += 250) {
    db.ingest("scale", Array.from({ length: Math.min(250, count - start) }, (_, index) => ({ type: start + index < movies ? "movie" : "series", title: `Film ${start + index}`, sourceKey: `source-${start + index}`, externalIDs: { tmdb: String(start + index + 1) }, year: 2000 + index % 25, categories: [{ key: (start + index) % 1000 === 0 ? "rare" : "general", name: (start + index) % 1000 === 0 ? "Rare" : "General", kind: "mixed" }] })));
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
  }
  const ingestionMs = performance.now() - started;
  assert.equal(db.sql("SELECT count(*) AS n FROM MediaItems").get().n, count);
  assert.equal(db.sql("SELECT count(*) AS n FROM Movies").get().n, movies);
  assert.equal(db.sql("SELECT count(*) AS n FROM Series").get().n, series);
  const tail = db.page({ sourceIds: ["scale"], after: count - 50, limit: 50 });
  assert.equal(tail.length, 50);
  const synthetic = db.synthetic("xtream", tail.at(-1).id);
  const canonicalId = tail.at(-1).canonicalId;
  db.close();
  db = new MediaGraph(filename, { secret });
  const lookupStart = performance.now();
  const restored = db.fromSynthetic("xtream", synthetic);
  const lookupMs = performance.now() - lookupStart;
  assert.equal(restored.canonicalId, canonicalId);
  assert.equal(db.page({ sourceIds: ["scale"], search: `Film ${count - 1}` })[0].id, restored.id);
  const category = db.sql("SELECT id FROM Categories WHERE source_key='rare'").get().id;
  const originalMedia = db.media.bind(db);
  let hydrated = 0, categoryRows = 0, after = 0;
  db.media = (id) => { hydrated++; return originalMedia(id); };
  const categoryStart = performance.now();
  while (true) {
    const page = db.page({ sourceIds: ["scale"], categoryId: category, after, limit: 7 });
    if (!page.length) break;
    for (const media of page) assert.equal(Number(media.externalIDs.tmdb) % 1000, 1);
    categoryRows += page.length; after = page.at(-1).id;
  }
  const categoryMs = performance.now() - categoryStart;
  assert.equal(categoryRows, Math.ceil(count / 1000));
  assert.equal(hydrated, categoryRows, "Category paging must not hydrate unrelated titles");
  const countStart = performance.now();
  assert.equal(db.count({ sourceIds: ["scale"] }), count);
  assert.equal(db.count({ sourceIds: ["scale"], categoryId: category, limit: 1, offset: count }), categoryRows);
  const countMs = performance.now() - countStart;
  assert.equal(hydrated, categoryRows, "Totals must not hydrate any media records");
  db.media = originalMedia;
  assert.ok(maxRss - initialRss < 160 * 1024 * 1024, "Memory growth exceeded 160 MB for bounded ingestion");
  const report = { items: count, movies, series, ingestionMs: Math.round(ingestionMs), restartLookupMs: Number(lookupMs.toFixed(3)), peakRssMB: Math.round(maxRss / 1048576), rssGrowthMB: Math.round((maxRss - initialRss) / 1048576), pageSize: 250, categoryRows, categoryHydrated: hydrated, categoryMs: Number(categoryMs.toFixed(3)), countMs: Number(countMs.toFixed(3)), countHydrated: 0, verified: true };
  fs.mkdirSync(path.join(__dirname, "../artifacts"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "../artifacts/scale.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { if (db?.db.open) db.close(); fs.rmSync(directory, { recursive: true, force: true }); }

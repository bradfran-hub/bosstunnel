"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { MediaGraph, IdentityConflict } = require("../core/graph");
const { BoundedCache, createCaches } = require("../core/cache");
const { capabilities, validateAdapter } = require("../core/model");
const secret = "test-stable-canonical-graph-encryption-key";
const graph = () => new MediaGraph(":memory:", { secret });
function source(db, id, extra = {}) { return db.addSource({ id, protocol: "test", name: id, configuration: { password: "private-source-password" }, capabilities: { catalog: true, streams: true, types: ["movie", "series", "episode"] }, ...extra }); }
const movie = (sourceKey, externalIDs = {}) => ({ sourceKey, type: "movie", title: "Inception", year: 2010, externalIDs });
test("output sessions persist with isolated credentials, expiry, rotation and library revocation", () => {
  const { OutputAuth } = require("../core/output-auth");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-output-auth-"));
  const file = path.join(dir, "graph.db");
  let now = 1000, db = new MediaGraph(file, { secret, clock: () => now });
  try {
    source(db, "one"); source(db, "two");
    let collection = db.createCollection({ name: "Customer", sourceIds: ["one", "two"] });
    const other = db.createCollection({ name: "Other customer", sourceIds: ["two"] });
    let auth = new OutputAuth(db, { ttlMs: 1000, maxSessions: 2 });
    const credentials = auth.provision(collection.id, "jellyfin");
    const emby = auth.provision(collection.id, "emby");
    const unrelated = auth.provision(other.id, "jellyfin");
    assert.notEqual(credentials.password, emby.password);
    assert.notEqual(credentials.username, unrelated.username);
    assert.throws(() => auth.provision(collection.id, "jellyfin"), { status: 409 });
    assert.throws(() => auth.authenticate("jellyfin", credentials.username, "private-source-password", { deviceId: "device" }), { status: 401 });
    assert.throws(() => auth.authenticate("emby", credentials.username, credentials.password, { deviceId: "device" }), { status: 401 });
    const login = deviceId => auth.authenticate("jellyfin", credentials.username, credentials.password, { deviceId });
    let first = login("device-a"), second = login("device-b");
    assert.throws(() => login("device-c"), { status: 429 });
    const replaced = login("device-a");
    assert.throws(() => auth.verify("jellyfin", first.token), { status: 401 });
    first = replaced;
    assert.throws(() => auth.verify("emby", first.token), { status: 401 });
    assert.equal(auth.revoke("emby", first.token), false);
    assert.equal(auth.verify("jellyfin", first.token).collectionId, collection.id);
    const stored = JSON.stringify(db.sql("SELECT * FROM OutputAccounts").all()) + JSON.stringify(db.sql("SELECT * FROM OutputSessions").all());
    for (const value of [credentials.password, emby.password, first.token, second.token, "device-a"]) assert.ok(!stored.includes(value));
    db.close(); db = new MediaGraph(file, { secret, clock: () => now });
    auth = new OutputAuth(db, { ttlMs: 1000, maxSessions: 2 });
    assert.equal(auth.verify("jellyfin", first.token).userId, credentials.userId);
    assert.equal(auth.revoke("jellyfin", second.token), true);
    assert.throws(() => auth.verify("jellyfin", second.token), { status: 401 });
    collection = db.updateCollection(collection.id, { name: collection.name, revision: collection.revision, sourceIds: ["two"] });
    assert.throws(() => auth.verify("jellyfin", first.token), { status: 401 });
    first = login("device-a");
    now = first.expiresAt;
    assert.throws(() => auth.verify("jellyfin", first.token), { status: 401 });
    first = login("device-a");
    const rotated = auth.rotate(collection.id, "jellyfin");
    assert.equal(rotated.userId, credentials.userId);
    assert.throws(() => auth.verify("jellyfin", first.token), { status: 401 });
    assert.throws(() => login("device-a"), { status: 401 });
    first = auth.authenticate("jellyfin", rotated.username, rotated.password, { deviceId: "device-a" });
    db.updateSource("two", { enabled: false });
    assert.throws(() => auth.verify("jellyfin", first.token), { status: 401 });
    db.sql("DELETE FROM Collections WHERE id=?").run(collection.id);
    assert.equal(db.sql("SELECT count(*) n FROM OutputSessions").get().n, 0);
    assert.equal(db.sql("SELECT count(*) n FROM OutputAccounts").get().n, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("schema ten upgrades output authentication storage without changing media IDs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-output-migration-"));
  const file = path.join(dir, "graph.db");
  let db = new MediaGraph(file, { secret });
  try {
    source(db, "one"); const [id] = db.ingest("one", [movie("owned")]);
    const synthetic = db.synthetic("xtream", id), canonical = db.media(id).canonicalId;
    db.db.exec("DROP TABLE OutputPlays; DROP TABLE OutputUserData; DROP TABLE OutputSessions; DROP TABLE OutputAccounts; PRAGMA user_version=10");
    db.close(); db = new MediaGraph(file, { secret });
    assert.equal(db.db.pragma("user_version", { simple: true }), 16);
    assert.equal(db.fromSynthetic("xtream", synthetic).canonicalId, canonical);
    assert.equal(db.sql("SELECT count(*) n FROM OutputAccounts").get().n, 0);
    assert.equal(db.sql("SELECT count(*) n FROM OutputSessions").get().n, 0);
    const { snapshot } = require("../backup.cjs");
    assert.equal((await snapshot(file, path.join(dir, "verified.db"), { secret })).schema, 16);
    db.db.exec("DROP TABLE OutputSessions");
    await assert.rejects(snapshot(file, path.join(dir, "invalid.db"), { secret }), /Not a Boss database/);
    assert.equal(fs.existsSync(path.join(dir, "invalid.db")), false);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("schema eleven upgrades user state, preserves it across restart and canonical merging", async () => {
  const { OutputAuth } = require("../core/output-auth");
  const { OutputState } = require("../core/output-state");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-output-state-")), file = path.join(dir, "graph.db");
  let now = 1000, db = new MediaGraph(file, { secret, clock: () => now });
  try {
    source(db, "one");
    const [first, second] = db.ingest("one", [movie("one", { imdb: "tt1375666" }), { ...movie("two", { tmdb: "27205" }), title: "Different source title" }]);
    const collection = db.createCollection({ name: "User state", sourceIds: ["one"] });
    let auth = new OutputAuth(db), credentials = auth.provision(collection.id, "jellyfin");
    const session = auth.authenticate("jellyfin", credentials.username, credentials.password, { deviceId: "device" });
    db.db.exec("DROP TABLE OutputPlays; DROP TABLE OutputUserData; PRAGMA user_version=11");
    db.close(); db = new MediaGraph(file, { secret, clock: () => now });
    assert.equal(db.db.pragma("user_version", { simple: true }), 16);
    auth = new OutputAuth(db); let state = new OutputState(db, auth, "jellyfin");
    const a = db.media(first), b = db.media(second);
    const playA = state.create(session.token, a, [{ url: "https://owned.example/private-resource" }]);
    state.report(session.token, playA.id, a, "start", 10);
    state.update(session, a, { IsFavorite: true });
    now++;
    const playB = state.create(session.token, b);
    state.report(session.token, playB.id, b, "start", 20);
    state.update(session, b, { Played: true, IsFavorite: false });
    assert.ok(!JSON.stringify(db.sql("SELECT * FROM OutputPlays").all()).includes("private-resource"));
    assert.throws(() => state.update(session, a, { PlaybackPositionTicks: Number.MAX_SAFE_INTEGER }), { status: 400 });
    assert.throws(() => state.update(session, a, { IsFavorite: "true" }), { status: 400 });
    assert.throws(() => state.update(session, a, { PlayCount: 10 }), { status: 400 });
    db.merge(first, second);
    const expected = state.read(session, db.media(first));
    assert.equal(expected.PlayCount, 2); assert.equal(expected.PlaybackPositionTicks, 20); assert.equal(expected.Played, true); assert.equal(expected.IsFavorite, false);
    assert.equal(state.verify(session.token, playB.id, db.media(second)).play.media_id, first);
    db.close(); db = new MediaGraph(file, { secret, clock: () => now });
    auth = new OutputAuth(db); state = new OutputState(db, auth, "jellyfin");
    assert.deepEqual(state.read(session, db.media(first)), expected);
    for (let i = 0; i < 62; i++) state.create(session.token, db.media(first));
    assert.throws(() => state.create(session.token, db.media(first)), { status: 429 });
    auth.revoke("jellyfin", session.token);
    assert.equal(db.sql("SELECT count(*) n FROM OutputPlays").get().n, 0);
    assert.deepEqual(state.read(session, db.media(first)), expected);
    const { snapshot } = require("../backup.cjs");
    assert.equal((await snapshot(file, path.join(dir, "verified.db"), { secret })).schema, 16);
    db.db.exec("DROP TABLE OutputUserData");
    await assert.rejects(snapshot(file, path.join(dir, "invalid.db"), { secret }), /Not a Boss database/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("scheduled backups verify before rotation and preserve unrelated files", async () => {
  const { scheduled } = require("../backup.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-scheduled-test-"));
  const input = path.join(dir, "source.db"), backups = path.join(dir, "snapshots");
  const db = new MediaGraph(input, { secret });
  try {
    source(db, "one"); db.ingest("one", [movie("film")]);
    const first = await scheduled(input, backups, { secret, keep: 2 });
    fs.writeFileSync(path.join(backups, "manual.sqlite"), "Keep this file");
    await scheduled(input, backups, { secret, keep: 2 });
    const third = await scheduled(input, backups, { secret, keep: 2 });
    assert.equal(third.retained, 2); assert.equal(third.removed, 1);
    assert.equal(fs.readdirSync(backups).filter(file => file.startsWith("boss-scheduled-")).length, 2);
    assert.equal(fs.readFileSync(path.join(backups, "manual.sqlite"), "utf8"), "Keep this file");
    assert.equal(fs.statSync(third.output).mode & 0o777, 0o600);
    const before = fs.readdirSync(backups).sort();
    await assert.rejects(scheduled(input, backups, { secret: "incorrect-key-that-is-at-least-32-characters", keep: 1 }), /cannot decrypt/);
    assert.deepEqual(fs.readdirSync(backups).sort(), before);
    assert.equal(first.sources, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("backup verification rejects inconsistent search indexes before publication or rotation", async () => {
  const { scheduled } = require("../backup.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-search-backup-"));
  const input = path.join(dir, "source.db"), backups = path.join(dir, "snapshots");
  const db = new MediaGraph(input, { secret });
  try {
    source(db, "one"); const [id] = db.ingest("one", [movie("film")]);
    const valid = await scheduled(input, backups, { secret, keep: 1 });
    assert.deepEqual(valid.searchIndexes, ["MediaSearch", "SourceMediaSearch"]);
    const files = fs.readdirSync(backups);
    const row = db.sql("SELECT rowid FROM Metadata WHERE media_id=?").get(id);
    db.sql("INSERT INTO SourceMediaSearch(SourceMediaSearch,rowid,title,original_title) VALUES('delete',?,'Inception',NULL)").run(row.rowid);
    assert.equal(db.db.pragma("integrity_check", { simple: true }), "ok");
    await assert.rejects(scheduled(input, backups, { secret, keep: 1 }), /Search index consistency check failed/);
    assert.deepEqual(fs.readdirSync(backups), files);
    db.sql("INSERT INTO SourceMediaSearch(SourceMediaSearch) VALUES('rebuild')").run();
    db.sql("INSERT INTO MediaSearch(MediaSearch,rowid,title,original_title) VALUES('delete',?,'Inception',NULL)").run(id);
    await assert.rejects(scheduled(input, backups, { secret, keep: 1 }), /Search index consistency check failed/);
    assert.deepEqual(fs.readdirSync(backups), files);
    assert.ok(fs.existsSync(valid.output));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("playback evidence persists private HTTP fingerprints, distinguishes probes, and expires", () => {
  const { PlaybackEvidence } = require("../core/playback-evidence");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-evidence-"));
  const filename = path.join(dir, "graph.db");
  let now = Date.now();
  let db = new MediaGraph(filename, { secret, clock: () => now });
  try {
    source(db, "one"); source(db, "two");
    const [id] = db.ingest("one", [movie("film")]);
    const candidate = { sourceId: "one", resource: { url: "https://private.example/file?token=private-password" }, requiredHeaders: { Authorization: "secret-token" } };
    let evidence = new PlaybackEvidence(db, { maxEntries: 2 });
    const fingerprint = evidence.fingerprint(id, candidate);
    evidence.record(id, candidate, { outcome: "complete", bytes: 1024 });
    assert.equal(evidence.summary().successfulTransfers, 0);
    assert.equal(evidence.bonus(id, candidate), 0);
    evidence.record(id, candidate, { outcome: "complete", bytes: 2 * 1048576 });
    assert.equal(evidence.bonus(id, candidate), 5);
    evidence.record(id, candidate, { outcome: "interrupted" });
    assert.equal(evidence.summary().failures, 0);
    assert.equal(evidence.summary().interruptions, 1);
    assert.equal(evidence.bonus(id, { ...candidate, sourceId: "two" }), 0);
    const rows = JSON.stringify(db.sql("SELECT * FROM PlaybackEvidence").all());
    assert.ok(!rows.includes("private") && !rows.includes("secret-token"));
    db.close(); db = new MediaGraph(filename, { secret, clock: () => now });
    evidence = new PlaybackEvidence(db, { maxEntries: 2 });
    assert.equal(evidence.fingerprint(id, candidate), fingerprint);
    assert.equal(evidence.summary().successfulTransfers, 1);
    const [survivor] = db.ingest("two", [{ type: "movie", sourceKey: "survivor", title: "Surviving title", externalIDs: { imdb: "tt1375666" } }]);
    db.db.transaction(() => db.merge(survivor, id))();
    assert.equal(evidence.bonus(survivor, candidate), 5);
    assert.equal(evidence.bonus(survivor, { ...candidate, resource: { url: "https://private.example/different" } }), 0);
    assert.equal(evidence.bonus(survivor, { ...candidate, sourceId: "two" }), 0);
    db.sql("UPDATE Sources SET revision=revision+1 WHERE id='one'").run();
    assert.equal(evidence.bonus(survivor, candidate), 0);
    db.sql("UPDATE Sources SET revision=revision-1 WHERE id='one'").run();
    now += 86400001;
    assert.equal(evidence.bonus(id, candidate), 0);
    for (let i = 0; i < 3; i++) evidence.record(id, { ...candidate, resource: { url: `https://private.example/${i}` } });
    assert.equal(evidence.summary().resources, 2);
    now += 91 * 86400000;
    evidence.record(id, candidate);
    assert.equal(evidence.summary().resources, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("failure evidence survives migration and merging until a newer successful transfer", () => {
  const { PlaybackEvidence } = require("../core/playback-evidence");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-evidence-migration-"));
  const filename = path.join(dir, "graph.db");
  let now = Date.now();
  let db = new MediaGraph(filename, { secret, clock: () => now });
  try {
    source(db, "one"); source(db, "two");
    const [id] = db.ingest("one", [movie("film")]);
    const [survivor] = db.ingest("two", [movie("other")]);
    const candidate = { sourceId: "one", resource: { url: "https://media.example/movie.mp4" } };
    let evidence = new PlaybackEvidence(db);
    evidence.record(id, candidate, { outcome: "complete", bytes: 2097152 });
    db.db.exec("ALTER TABLE PlaybackEvidence DROP COLUMN last_failure; PRAGMA user_version=7");
    db.close(); db = new MediaGraph(filename, { secret, clock: () => now });
    evidence = new PlaybackEvidence(db);
    assert.equal(evidence.summary().successfulTransfers, 1);
    assert.equal(evidence.bonus(id, candidate), 5);
    now++;
    evidence.record(id, candidate, { outcome: "failure" });
    assert.equal(evidence.bonus(id, candidate), 0);
    db.db.transaction(() => db.merge(survivor, id))();
    assert.equal(evidence.bonus(survivor, candidate), 0);
    now++;
    evidence.record(id, candidate, { outcome: "probe" });
    evidence.record(survivor, candidate, { outcome: "interrupted" });
    evidence.record(survivor, candidate, { outcome: "complete", bytes: Infinity });
    assert.equal(evidence.summary().successfulTransfers, 1);
    assert.equal(evidence.bonus(survivor, candidate), 0);
    now++;
    evidence.record(id, candidate, { outcome: "complete", bytes: 2097152 });
    assert.equal(evidence.bonus(survivor, candidate), 5);
    now++;
    evidence.record(id, candidate, { outcome: "failure" });
    assert.equal(evidence.bonus(survivor, candidate), 0);
    db.close(); db = new MediaGraph(filename, { secret, clock: () => now });
    evidence = new PlaybackEvidence(db);
    assert.equal(evidence.bonus(survivor, candidate), 0);
    assert.equal(evidence.summary().successfulTransfers, 2);
    assert.equal(evidence.summary().failures, 2);
    assert.equal(db.db.pragma("user_version", { simple: true }), 16);
    db.db.exec("ALTER TABLE PlaybackEvidence DROP COLUMN last_failure; PRAGMA user_version=7");
    db.close(); db = new MediaGraph(filename, { secret, clock: () => now });
    evidence = new PlaybackEvidence(db);
    assert.equal(evidence.bonus(survivor, candidate), 0, "legacy failures need fresh positive evidence");
    assert.equal(evidence.summary().successfulTransfers, 2);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("legacy categories survive migration and canonical merging until explicit full-refresh retirement", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-category-migration-"));
  const filename = path.join(dir, "graph.db");
  let db = new MediaGraph(filename, { secret });
  try {
    source(db, "one"); source(db, "two");
    const [id] = db.ingest("one", [{ ...movie("film"), categories: [{ key: "old", name: "Old" }] }]);
    const [survivor] = db.ingest("two", [{ ...movie("other"), categories: [{ key: "drama", name: "Drama" }] }]);
    db.db.exec("DROP TABLE CategoryProvenance; PRAGMA user_version=8");
    db.close(); db = new MediaGraph(filename, { secret });
    assert.equal(db.sql("SELECT count(*) n FROM CategoryProvenance").get().n, 2);
    db.db.transaction(() => db.merge(survivor, id))();
    db.ingest("one", [{ ...movie("film"), categories: [{ key: "new", name: "New" }] }], { catalogKey: "movies", generation: 2 });
    assert.equal(db.sql("SELECT count(*) n FROM MediaCategories WHERE media_id=?").get(survivor).n, 3);
    db.db.transaction(() => require("../core/categories").retireLegacy(db, "one"))();
    assert.deepEqual(db.sql("SELECT c.name FROM MediaCategories mc JOIN Categories c ON c.id=mc.category_id WHERE mc.media_id=? ORDER BY c.name").all(survivor).map(row => row.name), ["Drama", "New"]);
    db.close(); db = new MediaGraph(filename, { secret });
    assert.equal(db.sql("SELECT count(*) n FROM MediaCategories WHERE media_id=?").get(survivor).n, 2);
    assert.deepEqual(db.db.pragma("foreign_key_check"), []);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("source title search migrates, updates, merges and excludes unrelated or inactive metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-source-search-"));
  const filename = path.join(dir, "graph.db");
  let db = new MediaGraph(filename, { secret });
  try {
    source(db, "one"); source(db, "two", { priority: 10 });
    const [first] = db.ingest("one", [{ ...movie("first"), title: "Localised Film", originalTitle: "Original Cinema" }]);
    const [second] = db.ingest("two", [{ ...movie("second"), title: "Unrelated Alias" }]);
    db.db.exec("DROP TRIGGER SourceMediaSearch_insert; DROP TRIGGER SourceMediaSearch_update; DROP TRIGGER SourceMediaSearch_delete; DROP TABLE SourceMediaSearch; DROP VIEW SourceSearchContent; PRAGMA user_version=9");
    db.close(); db = new MediaGraph(filename, { secret });
    db.db.transaction(() => db.merge(second, first))();
    const find = (search, sourceIds = ["one"]) => db.page({ sourceIds, search }).map(row => row.id);
    assert.deepEqual(find("Localis"), [second]);
    assert.deepEqual(find("Original"), [second]);
    assert.deepEqual(find("Unrelated"), []);
    assert.deepEqual(find("Unrelated", ["one", "two"]), [second]);
    db.ingest("one", [{ ...movie("first"), title: "Renamed Film" }]);
    assert.deepEqual(find("Localised"), []);
    assert.deepEqual(find("Original"), []);
    assert.deepEqual(find("Renamed"), [second]);
    db.sql("UPDATE SourceMappings SET active=0 WHERE source_id='one'").run();
    assert.deepEqual(find("Renamed", ["one", "two"]), []);
    db.sql("UPDATE SourceMappings SET active=1 WHERE source_id='one'").run();
    db.sql("UPDATE Sources SET enabled=0 WHERE id='one'").run();
    assert.deepEqual(find("Renamed", ["one", "two"]), []);
    db.sql("UPDATE Sources SET enabled=1 WHERE id='one'").run();
    db.close(); db = new MediaGraph(filename, { secret });
    assert.deepEqual(find("Renamed"), [second]);
    db.removeSource("one");
    assert.deepEqual(find("Renamed", ["two"]), []);
    db.sql("INSERT INTO SourceMediaSearch(SourceMediaSearch,rank) VALUES('integrity-check',1)").run();
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("playback backoff honors seconds and HTTP dates with bounded source-scoped state", () => {
  const { PlaybackBackoff, retrySeconds } = require("../core/playback-backoff");
  let now = Date.parse("2026-09-06T00:00:00Z");
  assert.equal(retrySeconds("120", now), 120);
  assert.equal(retrySeconds("Sun, 06 Sep 2026 00:02:00 GMT", now), 120);
  assert.equal(retrySeconds(null, now), 60);
  assert.equal(retrySeconds("nonsense", now), 60);
  assert.equal(retrySeconds("0", now), 1);
  const backoff = new PlaybackBackoff({ clock: () => now, limit: 2 });
  backoff.record("source-a:1", "https://media.example/private?token=secret", "120");
  assert.throws(() => backoff.check("source-a:1", "https://media.example/another"), e => e.status === 429 && e.retryAfter === 120);
  assert.doesNotThrow(() => backoff.check("source-b:1", "https://media.example/another"));
  assert.doesNotThrow(() => backoff.check("source-a:2", "https://media.example/another"));
  assert.doesNotThrow(() => backoff.check("source-a:1", "https://another.example/file"));
  assert.ok(!JSON.stringify([...backoff.entries]).includes("secret"));
  now += 120000;
  assert.doesNotThrow(() => backoff.check("source-a:1", "https://media.example/file"));
  for (let i = 0; i < 4; i++) backoff.record(String(i), "https://media.example/file", "60");
  assert.equal(backoff.entries.size, 2);
});

test("playback diagnostics record failures without credentials or upstream URLs", () => {
  const { EventEmitter } = require("node:events");
  const { playbackTrace } = require("../core/playback-trace");
  const res = new EventEmitter(); res.statusCode = 206; res.writableFinished = true;
  const records = [];
  const trace = playbackTrace({ method: "GET", url: "/series/private-user/private-password/1.mp4" }, res, "series", "1", (record) => records.push(record));
  trace.failure({ status: 422, message: "Playback returned HTTP 503", refreshPlayback: true });
  trace.failure({ message: "https://private.example/private-token" });
  res.emit("finish"); res.emit("close");
  assert.equal(records.length, 4);
  assert.equal(records[1].upstreamStatus, 503);
  assert.equal(records.at(-1).completed, true);
  assert.equal(JSON.stringify(records).includes("private"), false);
});

test("playback profiles accept default and case-insensitive language codes with field-specific errors", () => {
  const { playbackProfile } = require("../core/profile");
  assert.equal(playbackProfile({}).language, "");
  assert.equal(playbackProfile({ language: " EN-us " }).language, "en-us");
  for (const [profile, field] of [[{ language: "English" }, "preferred language"], [{ codecs: ["invalid"] }, "video codecs"], [{ maxHeight: -1 }, "maximum resolution"], [{ hdr: "true" }, "hdr"], [{ strictCapabilities: "false" }, "strictCapabilities"]]) {
    assert.throws(() => playbackProfile(profile), (error) => error.status === 400 && error.message.includes(field));
  }
});

test("admin failure limiter expires cooldowns and bounds peer tracking without evicting active limits", () => {
  const { AuthLimit } = require("../core/auth-limit");
  let now = 0;
  const limit = new AuthLimit({ failures: 2, windowMs: 60000, maximumPeers: 2, clock: () => now });
  assert.equal(limit.check("one"), 0); limit.failed("one");
  assert.equal(limit.check("one"), 0); limit.failed("one");
  assert.equal(limit.check("one"), 60);
  limit.failed("two"); assert.equal(limit.check("three"), 60);
  assert.equal(limit.peers.size, 2);
  limit.succeeded("two"); assert.equal(limit.check("three"), 0);
  now = 59001; assert.equal(limit.check("one"), 1);
  now = 60000; assert.equal(limit.check("one"), 0); assert.equal(limit.peers.size, 0);
});

test("online backup and offline restore retain IDs, libraries and encrypted credentials without overwrites", async () => {
  const { snapshot } = require("../backup.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recovery-"));
  const live = path.join(dir, "live.db"), backup = path.join(dir, "backup.sqlite"), restored = path.join(dir, "restored.db");
  let db, recovered;
  try {
    db = new MediaGraph(live, { secret }); source(db, "one");
    const [id] = db.ingest("one", [movie("first", { imdb: "tt1375666" })]);
    const canonical = db.media(id).canonicalId, synthetic = db.synthetic("xtream", id);
    const library = db.createCollection({ name: "Recovered library", sourceIds: ["one"] });
    assert.equal(db.db.pragma("journal_mode", { simple: true }), "wal");
    const report = await snapshot(live, backup);
    assert.equal(report.mediaItems, 1); assert.equal(report.sources, 1);
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(backup).includes(Buffer.from("private-source-password")));
    db.ingest("one", [{ ...movie("later", { imdb: "tt0251160" }), title: "Later movie" }]);
    assert.equal(db.sql("SELECT count(*) n FROM MediaItems").get().n, 2);
    await assert.rejects(snapshot(backup, restored, { secret: "incorrect-recovery-key-at-least-32-characters" }), /cannot decrypt/);
    assert.equal(fs.existsSync(restored), false);
    const result = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "../backup.cjs"), "restore", backup, restored], { encoding: "utf8", env: { ...process.env, BOSS_SECRET: secret } }));
    assert.equal(result.action, "restore");
    recovered = new MediaGraph(restored, { secret });
    assert.equal(recovered.sql("SELECT count(*) n FROM MediaItems").get().n, 1);
    assert.equal(recovered.fromSynthetic("xtream", synthetic).canonicalId, canonical);
    assert.deepEqual(recovered.collection(library.id).sourceIds, ["one"]);
    assert.equal(recovered.source("one", { credentials: true }).configuration.password, "private-source-password");
    await assert.rejects(snapshot(live, backup), /overwriting is refused/);
    assert.equal(recovered.db.pragma("foreign_key_check").length, 0);
    assert.ok(!fs.readdirSync(dir).some((name) => name.startsWith(".boss-backup-")));
  } finally { recovered?.close(); db?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("schema 7 migrates only unambiguous legacy guide IDs and preserves new mappings on reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-guide-migration-"));
  const file = path.join(dir, "graph.sqlite");
  let db;
  try {
    db = new MediaGraph(file, { secret });
    source(db, "one"); source(db, "two");
    const channel = (sourceKey, id) => ({ sourceKey, type: "channel", title: sourceKey, externalIDs: { tvdb: id }, channel: { epgId: sourceKey } });
    db.ingest("one", [channel("only", "1"), channel("shared-first", "2")]);
    db.ingest("two", [channel("shared-second", "2")]);
    db.db.exec("DROP TABLE SourceGuideIDs; PRAGMA user_version=6");
    db.close(); db = new MediaGraph(file, { secret });
    assert.equal(db.db.pragma("user_version", { simple: true }), 16);
    assert.deepEqual(db.sql("SELECT epg_id FROM SourceGuideIDs").all().map((row) => row.epg_id), ["only"]);
    db.ingest("one", [channel("shared-first", "2")]);
    db.ingest("two", [channel("shared-second", "2")]);
    db.close(); db = new MediaGraph(file, { secret });
    assert.equal(db.sql("SELECT count(*) n FROM SourceGuideIDs").get().n, 3);
    assert.equal(db.db.pragma("foreign_key_check").length, 0);
  } finally { db?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("canonical identity deduplicates across sources without resolving streams", () => {
  const db = graph();
  try {
    source(db, "one"); source(db, "two");
    const [a] = db.ingest("one", [movie("native-001", { imdb: "tt1375666", tmdb: "27205" })]);
    const [b] = db.ingest("two", [movie("tt1375666", { imdb: "tt1375666" })]);
    assert.equal(a, b);
    assert.equal(db.page({ sourceIds: ["one", "two"] }).length, 1);
    assert.equal(db.mappings(a, ["one", "two"]).length, 2);
    assert.equal(db.media(a).playbackState, "UNRESOLVED");
    assert.equal(db.media(a).externalIDs.tmdb, "27205");
    assert.deepEqual(db.page({ sourceIds: [] }), []);
    assert.deepEqual(db.mappings(a, ["unauthorized"]), []);
  } finally { db.close(); }
});
test("identity namespaces distinguish movies from series and fallback is controlled", () => {
  const db = graph();
  try {
    source(db, "one"); source(db, "two");
    const [film] = db.ingest("one", [movie("film", { tmdb: "99" })]);
    const [series] = db.ingest("one", [{ ...movie("show", { tmdb: "99" }), type: "series" }]);
    assert.notEqual(film, series);
    const [unknown] = db.ingest("two", [movie("unknown")]);
    assert.notEqual(film, unknown);
    assert.throws(() => db.ingest("one", [movie("film", { tmdb: "100" })]), IdentityConflict);
    const [original] = db.ingest("one", [{ ...movie("another", { imdb: "tt0000001" }), title: "Another", year: 2000 }]);
    const [matched] = db.ingest("two", [{ ...movie("fallback"), title: "ANOTHER", year: 2000 }], { allowTitleFallback: true });
    assert.equal(original, matched);
  } finally { db.close(); }
});
test("reliable identity bridges merge existing nodes and retain old output IDs", () => {
  const db = graph();
  try {
    for (const id of ["one", "two", "three"]) source(db, id);
    const [a] = db.ingest("one", [movie("a", { imdb: "tt1375666" })]);
    const [b] = db.ingest("two", [movie("b", { tmdb: "27205" })]);
    const oldCanonical = db.media(b).canonicalId;
    const oldSynthetic = db.synthetic("xtream", b);
    const [merged] = db.ingest("three", [movie("c", { imdb: "tt1375666", tmdb: "27205" })]);
    assert.equal(merged, a);
    assert.equal(db.fromSynthetic("xtream", oldSynthetic).id, a);
    assert.equal(db.media(oldCanonical).id, a);
    assert.equal(db.mappings(a, ["one", "two", "three"]).length, 3);
    assert.equal(db.page({ sourceIds: ["one", "two", "three"] }).length, 1);
  } finally { db.close(); }
});
test("series seasons and episode identities survive source differences", () => {
  const db = graph();
  try {
    source(db, "one"); source(db, "two");
    const [series] = db.ingest("one", [{ type: "series", title: "Breaking Bad", sourceKey: "tt0903747", externalIDs: { imdb: "tt0903747" } }]);
    const [episode] = db.ingest("one", [{ type: "episode", title: "Pilot", sourceKey: "tt0903747:1:1", seriesId: series, seasonNumber: 1, episodeNumber: 1 }]);
    const [same] = db.ingest("two", [{ type: "episode", title: "Pilot", sourceKey: "emby-episode-42", seriesId: series, seasonNumber: 1, episodeNumber: 1 }]);
    assert.equal(episode, same);
    const media = db.media(same);
    assert.equal(media.seriesId, series); assert.equal(media.seasonNumber, 1); assert.equal(media.episodeNumber, 1);
    assert.equal(db.media(media.seasonId).type, "season");
    assert.equal(db.mappings(same, ["one"])[0].sourceKey, "tt0903747:1:1");
    assert.equal(db.page({ sourceIds: ["one"], types: ["episode"], seriesId: series }).length, 1);
  } finally { db.close(); }
});
test("merging independently indexed series retains episode output aliases and richer metadata", () => {
  const db = graph();
  try {
    source(db, "one"); source(db, "two", { priority: 10 }); source(db, "bridge");
    const [first] = db.ingest("one", [{ type: "series", sourceKey: "first", title: "Show", externalIDs: { imdb: "tt0903747" } }]);
    const [second] = db.ingest("two", [{ type: "series", sourceKey: "second", title: "Breaking Bad", description: "Detailed metadata", externalIDs: { tmdb: "1396" } }]);
    const [a] = db.ingest("one", [{ type: "episode", sourceKey: "e1", title: "Pilot", seriesId: first, seasonNumber: 1, episodeNumber: 1 }]);
    const [b] = db.ingest("two", [{ type: "episode", sourceKey: "e2", title: "Pilot", seriesId: second, seasonNumber: 1, episodeNumber: 1 }]);
    const alias = db.synthetic("xtream", b);
    db.ingest("bridge", [{ type: "series", sourceKey: "shared", title: "Show", externalIDs: { imdb: "tt0903747", tmdb: "1396" } }]);
    assert.equal(db.fromSynthetic("xtream", alias).id, a);
    assert.equal(db.media(first).description, "Detailed metadata");
    assert.equal(db.media(first).title, "Breaking Bad");
    const [reimported] = db.ingest("bridge", [{ type: "episode", sourceKey: "old-parent-episode", title: "Pilot", seriesId: second, seasonNumber: 1, episodeNumber: 1 }]);
    assert.equal(reimported, a);
    const [season] = db.ingest("bridge", [{ type: "season", sourceKey: "old-parent-season", title: "Season 1", seriesId: second, seasonNumber: 1 }]);
    assert.equal(db.media(season).seriesId, first);
    const [next] = db.ingest("bridge", [{ type: "episode", sourceKey: "old-parent-next", title: "Next", seriesId: second, seasonNumber: 2, episodeNumber: 1 }]);
    assert.equal(db.media(next).seriesId, first);
    assert.equal(db.fromSynthetic("xtream", alias).id, a);
    assert.deepEqual(db.sql("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});
test("atomic ingestion rolls back conflicting identities and secrets remain encrypted", () => {
  const db = graph();
  try {
    source(db, "one");
    db.ingest("one", [movie("existing", { imdb: "tt1375666" })]);
    assert.throws(() => db.ingest("one", [movie("new"), movie("existing", { imdb: "tt0000001" })]), IdentityConflict);
    assert.equal(db.page({ sourceIds: ["one"] }).length, 1);
    const [media] = db.ingest("one", [{ ...movie("safe"), resolverData: { url: "https://server/private?token=hidden" }, artwork: { poster: { url: "https://server/image", headers: { Authorization: "secret-image-token" } } } }]);
    const raw = JSON.stringify(db.sql("SELECT * FROM Sources").all()) + JSON.stringify(db.sql("SELECT * FROM SourceMappings").all()) + JSON.stringify(db.sql("SELECT * FROM Artwork").all()) + JSON.stringify(db.sql("SELECT * FROM Metadata").all());
    assert.ok(!raw.includes("private-source-password")); assert.ok(!raw.includes("secret-image-token")); assert.ok(!raw.includes("token=hidden"));
    assert.equal(db.mappings(media, ["one"])[0].resolverData.url, "https://server/private?token=hidden");
    db.updateSource("one", { enabled: false }); assert.deepEqual(db.page({ sourceIds: ["one"] }), []);
  } finally { db.close(); }
});
test("synthetic IDs persist across independent process restarts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-restart-"));
  const file = path.join(dir, "graph.db");
  const program = `const { MediaGraph } = require(${JSON.stringify(path.resolve(__dirname, "../core/graph"))}); const db=new MediaGraph(process.argv[1],{secret:process.env.TEST_GRAPH_SECRET}); if(!db.source('one')) {db.addSource({id:'one',protocol:'test',name:'one',configuration:{}}); db.ingest('one',[{type:'movie',title:'Inception',sourceKey:'tt1375666',externalIDs:{imdb:'tt1375666'}}]);} const media=db.page({sourceIds:['one']})[0]; console.log(JSON.stringify({canonical:media.canonicalId, synthetic:db.synthetic('xtream',media.id)})); db.close();`;
  try {
    const options = { env: { ...process.env, TEST_GRAPH_SECRET: secret }, encoding: "utf8" };
    const first = execFileSync(process.execPath, ["-e", program, file], options);
    const second = execFileSync(process.execPath, ["-e", program, file], options);
    assert.deepEqual(JSON.parse(first), JSON.parse(second));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("catalogue pages and search use database indexes and bounded results", () => {
  const db = graph();
  try {
    source(db, "one");
    for (let batch = 0; batch < 10; batch++) db.ingest("one", Array.from({ length: 500 }, (_, i) => ({ type: "movie", title: `Movie ${batch * 500 + i}`, sourceKey: String(batch * 500 + i) })));
    const first = db.page({ sourceIds: ["one"], limit: 50 });
    const second = db.page({ sourceIds: ["one"], limit: 50, after: first.at(-1).id });
    assert.equal(first.length, 50); assert.equal(second.length, 50); assert.ok(second[0].id > first.at(-1).id);
    assert.equal(db.page({ sourceIds: ["one"], search: "Movie 4999" })[0].title, "Movie 4999");
    const plan = db.sql("EXPLAIN QUERY PLAN SELECT media_id FROM SourceMappings WHERE source_id=? AND active=1 AND media_id>?").all("one", 1);
    assert.ok(plan.some((row) => row.detail.includes("SourceMappings_source")));
    assert.ok(db.statements.size <= 160);
  } finally { db.close(); }
});
test("caches expire independently and enforce byte and entry bounds", () => {
  let now = 0;
  const cache = new BoundedCache({ maxEntries: 2, maxBytes: 200, clock: () => now });
  cache.set("a", { value: 1 }, 10); cache.set("b", { value: 2 }, 20); cache.get("a"); cache.set("c", { value: 3 }, 20);
  assert.equal(cache.get("b"), undefined); now = 11; assert.equal(cache.get("a"), undefined);
  cache.set("large", "x".repeat(201), 20); assert.equal(cache.get("large"), undefined);
  assert.deepEqual(Object.keys(createCaches()), ["metadata", "artwork", "identity", "catalogPages", "sourceResponses", "resolution"]);
});
test("capabilities default to absent and declarations require implementations", () => {
  assert.equal(capabilities({ catalog: true }).epg, false);
  assert.throws(() => validateAdapter({ id: "bad", capabilities: capabilities({ streams: true }) }), /resolve/);
});

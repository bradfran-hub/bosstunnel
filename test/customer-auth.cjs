"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { MediaGraph } = require("../core/graph");
const { CustomerAuth } = require("../core/customer-auth");
const secret = "customer-auth-test-encryption-secret-long-enough";
const password = "test password 1!";

test("HTTPS account configuration sets Secure cookies and rejects cross-site session mutations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-customer-secure-"));
  const graph = new MediaGraph(path.join(dir, "graph.db"), { secret });
  const headers = {};
  const adapter = require("../protocols/customer-http").createCustomerHttp({ graph, baseUrl: "https://boss.example.com", basePath: "/",
    body: async () => ({ username: "secure-customer", password }), json: (res, status, data) => ({ status, data }) });
  try {
    const req = { method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: { origin: "https://boss.example.com", "content-type": "application/json", "sec-fetch-site": "same-origin" } };
    const response = await adapter.handle(req, { setHeader: (key, value) => { headers[key] = value; } }, "/register");
    assert.equal(response.status, 201); assert.match(headers["Set-Cookie"], /; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
    assert.ok(!headers["Set-Cookie"].includes("Path=//"));
    assert.ok(!/Domain=/.test(headers["Set-Cookie"])); assert.equal(response.data.token, undefined);
    const authenticated = { ...req, headers: { ...req.headers, cookie: headers["Set-Cookie"].split(";", 1)[0], "x-boss-csrf": response.data.csrfToken } };
    assert.equal(adapter.session(authenticated, true).customer.username, "secure-customer");
    assert.throws(() => adapter.session({ ...authenticated, headers: { ...authenticated.headers, "sec-fetch-site": "cross-site" } }, true), { status: 403 });
    assert.throws(() => adapter.session({ ...authenticated, headers: { ...authenticated.headers, origin: "http://boss.example.com" } }, true), { status: 403 });
    const access = adapter.auth.vaultAccess(response.data.customer.id);
    await assert.rejects(adapter.handle({ ...authenticated, headers: { ...authenticated.headers, "x-boss-csrf": "wrong" } }, {}, "/lock"), { status: 403 });
    const locked = await adapter.handle(authenticated, {}, "/lock");
    assert.equal(locked.data.vault.unlocked, false); assert.equal(access.signal.aborted, true);
    assert.throws(() => adapter.session(authenticated), { status: 423 });
    assert.throws(() => adapter.session(authenticated, true), { status: 423 });
    assert.equal((await adapter.handle({ ...authenticated, method: "GET" }, {}, "/me")).data.customer.username, null);
    const unlocked = await adapter.handle(authenticated, { setHeader: (key, value) => { headers[key] = value; } }, "/login");
    assert.equal(unlocked.data.vault.unlocked, true);
    assert.throws(() => access.assertCurrent(), { status: 423 });
    assert.equal(adapter.session({ ...authenticated, headers: { ...authenticated.headers, cookie: headers["Set-Cookie"].split(";", 1)[0] } }).vault.unlocked, true);
  } finally { await adapter.close(); graph.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("customer credentials survive restart and destructive recovery replaces an inaccessible vault", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-customer-auth-")), filename = path.join(dir, "graph.db");
  let now = 1000, graph = new MediaGraph(filename, { secret, clock: () => now }), auth = new CustomerAuth(graph, { maxSessions: 2, ttlMs: 10000 });
  try {
    const first = await auth.register({ username: "Customer.One", password }, "peer-a");
    assert.equal(first.customer.username, "customer.one");
    assert.match(first.recoveryCode, /^boss-recovery-[A-Za-z0-9_-]{43}$/);
    const stored = JSON.stringify(graph.sql("SELECT * FROM Customers").all()) + JSON.stringify(graph.sql("SELECT * FROM CustomerSessions").all());
    for (const value of ["customer.one", password, first.token, first.recoveryCode, first.csrfToken]) assert.ok(!stored.includes(value));
    assert.match(graph.sql("SELECT username FROM Customers").get().username, /^[a-f0-9]{64}$/);
    assert.match(graph.sql("SELECT encrypted_profile FROM Customers").get().encrypted_profile, /^boss-vault:1:/);
    assert.match(graph.sql("SELECT password_hash FROM Customers").get().password_hash, /^scrypt\$131072\$8\$1\$/);
    await assert.rejects(auth.register({ username: "customer.one", password }, "peer-b"), { status: 409 });
    await assert.rejects(auth.register({ username: "xx", password }, "peer-b"), { status: 400 });
    await assert.rejects(auth.register({ username: "no-digit", password: "password!" }, "peer-b"), { status: 400 });
    await assert.rejects(auth.register({ username: "no-special", password: "password1" }, "peer-b"), { status: 400 });
    await assert.rejects(auth.register({ username: "valid-name", password: "short" }, "peer-b"), { status: 400 });
    await assert.rejects(auth.login({ username: "customer.one", password: "incorrect" }, "peer-c"), { status: 401 });
    await assert.rejects(auth.login({ username: "does-not-exist", password }, "peer-c"), { status: 401 });
    const second = await auth.login({ username: "CUSTOMER.ONE", password }, "peer-c");
    assert.notEqual(second.token, first.token); assert.notEqual(second.csrfToken, first.csrfToken);
    assert.throws(() => auth.csrf(first.token, second.csrfToken), { status: 403 });
    assert.throws(() => auth.csrf(first.token, "\u00e9".repeat(64)), { status: 403 });
    assert.equal(auth.csrf(first.token, first.csrfToken).customer.id, first.customer.id);
    await auth.close(); graph.close(); graph = new MediaGraph(filename, { secret, clock: () => now }); auth = new CustomerAuth(graph, { maxSessions: 2, ttlMs: 10000 });
    assert.equal(auth.verify(first.token).customer.id, first.customer.id);
    auth.revoke(first.token); assert.throws(() => auth.verify(first.token), { status: 401 });
    await assert.rejects(auth.changePassword(second.token, { currentPassword: "wrong", password: `${password} new` }, "peer-d"), { status: 401 });
    const changed = await auth.changePassword(second.token, { currentPassword: password, password: `${password} new` }, "peer-d");
    assert.notEqual(changed.recoveryCode, first.recoveryCode);
    assert.throws(() => auth.verify(second.token), { status: 401 });
    await assert.rejects(auth.login({ username: "customer.one", password }, "peer-e"), { status: 401 });
    await assert.rejects(auth.recover({ username: "customer.one", recoveryCode: first.recoveryCode, password }, "peer-e"), { status: 401 });
    const resetPassword = `${password} reset`;
    const reset = await auth.recover({ username: "customer.one", recoveryCode: changed.recoveryCode, password: resetPassword }, "peer-f");
    assert.equal(reset.customer.id, first.customer.id); assert.equal(reset.vault.unlocked, true);
    assert.notEqual(reset.recoveryCode, changed.recoveryCode);
    assert.throws(() => auth.verify(changed.token), { status: 401 });
    await assert.rejects(auth.login({ username: "customer.one", password: `${password} new` }, "peer-f"), { status: 401 });
    now = reset.expiresAt;
    assert.throws(() => auth.verify(reset.token), { status: 401 });
    const active = await auth.login({ username: "customer.one", password: resetPassword }, "peer-g");
    const other = await auth.login({ username: "customer.one", password: resetPassword }, "peer-g");
    auth.revokeAll(active.token);
    assert.throws(() => auth.verify(other.token), { status: 401 });
    const disabled = await auth.login({ username: "customer.one", password: resetPassword }, "peer-h");
    graph.sql("UPDATE Customers SET enabled=0").run();
    assert.throws(() => auth.verify(disabled.token), { status: 401 });
    await assert.rejects(auth.login({ username: "customer.one", password }, "peer-h"), { status: 401 });
    await assert.rejects(auth.recover({ username: "customer.one", recoveryCode: reset.recoveryCode, password }, "peer-h"), { status: 401 });
  } finally { await auth.close(); graph.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("customer throttle state persists, expires and stores no raw usernames or peers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-customer-limits-")), filename = path.join(dir, "graph.db");
  let now = 1000, graph = new MediaGraph(filename, { secret, clock: () => now }), auth = new CustomerAuth(graph);
  try {
    for (let i = 0; i < 10; i++) auth.attempt(`private-peer-${i}`, "login", "private-user");
    assert.throws(() => auth.attempt("another-peer", "login", "private-user"), error => error.status === 429 && error.retryAfter === 900);
    const rows = JSON.stringify(graph.sql("SELECT * FROM CustomerAuthAttempts").all());
    assert.ok(!rows.includes("private-peer") && !rows.includes("private-user"));
    await auth.close(); graph.close(); graph = new MediaGraph(filename, { secret, clock: () => now }); auth = new CustomerAuth(graph);
    assert.throws(() => auth.attempt("new-peer", "login", "private-user"), { status: 429 });
    now += 900001; auth.attempt("new-peer", "login", "private-user");
    for (let i = 0; i < 5; i++) auth.attempt("registration-peer", "signup", `new-user-${i}`);
    assert.throws(() => auth.attempt("registration-peer", "signup", "next-user"), { status: 429 });
    for (let i = 0; i < 60; i++) auth.management("management-fixture", true);
    assert.throws(() => auth.management("management-fixture", true), { status: 429 });
    auth.management("another-management-fixture", true);
    for (let i = 0; i < 180; i++) auth.management("management-fixture");
    assert.throws(() => auth.management("management-fixture"), { status: 429 });
    await auth.close(); graph.close(); graph = new MediaGraph(filename, { secret, clock: () => now }); auth = new CustomerAuth(graph);
    assert.throws(() => auth.management("management-fixture"), { status: 429 });
    assert.ok(!JSON.stringify(graph.sql("SELECT * FROM CustomerAuthAttempts").all()).includes("management-fixture"));
    now += 60001; auth.management("management-fixture", true);
  } finally { await auth.close(); graph.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("password-confirmed account deletion revokes links and removes all owned storage", async () => {
  const graph = new MediaGraph(":memory:", { secret });
  const auth = new CustomerAuth(graph);
  try {
    const account = await auth.register({ username: "delete-customer", password }, "delete-peer");
    graph.addSource({ id: "delete-source", name: "Private source label", protocol: "fixture", configuration: { password: "upstream-secret" }, customerId: account.customer.id });
    const collection = graph.createCollection({ id: "delete-library", name: "Private library label", sourceIds: ["delete-source"], profile: { language: "en" }, customerId: account.customer.id });
    const links = new (require("../core/output-links").CustomerOutputLinks)(graph);
    const credentials = links.credentials(collection.id);
    const stored = JSON.stringify(graph.sql("SELECT username,encrypted_profile FROM Customers").get()) + graph.sql("SELECT name FROM Sources WHERE id=?").get("delete-source").name + graph.sql("SELECT name FROM Collections WHERE id=?").get(collection.id).name + graph.sql("SELECT profile FROM CollectionProfiles WHERE collection_id=?").get(collection.id).profile;
    for (const value of ["delete-customer", "Private source label", "Private library label", "upstream-secret"]) assert.ok(!stored.includes(value));
    await assert.rejects(auth.deleteAccount(account.token, { password, confirmation: "delete" }, "delete-peer"), { status: 400 });
    await assert.rejects(auth.deleteAccount(account.token, { password: "incorrect", confirmation: "DELETE" }, "delete-peer"), { status: 401 });
    assert.equal(graph.sql("SELECT count(*) n FROM Customers").get().n, 1);
    const deleted = await auth.deleteAccount(account.token, { password, confirmation: "DELETE" }, "delete-peer");
    assert.deepEqual(deleted.sourceIds, ["delete-source"]);
    for (const table of ["Customers", "CustomerSources", "CustomerCollections", "CustomerSessions", "CustomerVaults", "CustomerOutputLinks"]) assert.equal(graph.sql(`SELECT count(*) n FROM ${table}`).get().n, 0);
    assert.equal(graph.sql("SELECT count(*) n FROM Sources").get().n, 0);
    assert.equal(graph.sql("SELECT count(*) n FROM Collections").get().n, 0);
    assert.throws(() => links.resolve(credentials.token), { status: 401 });
    await assert.rejects(auth.login({ username: "delete-customer", password }, "delete-peer"), { status: 401 });
  } finally { await auth.close(); graph.close(); }
});

test("restoring a backup revokes web/output sessions and preserves owned libraries and stable media IDs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-customer-restore-")), file = path.join(dir, "live.db");
  const graph = new MediaGraph(file, { secret }), auth = new CustomerAuth(graph);
  let restored, restoredAuth;
  try {
    const customer = await auth.register({ username: "restore-customer", password }, "restore-fixture");
    graph.addSource({ id: "owned", name: "Owned", protocol: "fixture", configuration: { password: "protected-upstream" }, customerId: customer.customer.id });
    const library = graph.createCollection({ name: "Owned library", sourceIds: ["owned"], customerId: customer.customer.id });
    const [id] = graph.ingest("owned", [{ type: "movie", title: "Owned movie", sourceKey: "movie" }]);
    const synthetic = graph.synthetic("xtream", id), canonicalId = graph.media(id).canonicalId;
    const { OutputAuth } = require("../core/output-auth");
    const output = new OutputAuth(graph), credentials = output.provision(library.id, "jellyfin");
    const session = output.authenticate("jellyfin", credentials.username, credentials.password, { deviceId: "restore-fixture" });
    const { snapshot, restore } = require("../backup.cjs"), backup = path.join(dir, "backup.sqlite"), target = path.join(dir, "restored.db");
    await snapshot(file, backup, { secret });
    await assert.rejects(restore(backup, target), /requires the original/);
    assert.equal(fs.existsSync(target), false);
    const result = await restore(backup, target, { secret }); assert.equal(result.revokedSessions, 2);
    restored = new MediaGraph(target, { secret }); restoredAuth = new CustomerAuth(restored);
    assert.throws(() => restoredAuth.verify(customer.token), { status: 401 });
    assert.throws(() => new OutputAuth(restored).verify("jellyfin", session.token), { status: 401 });
    assert.equal(restored.fromSynthetic("xtream", synthetic).canonicalId, canonicalId);
    assert.throws(() => restored.collection(library.id), { status: 423 });
    assert.equal(restored.sql("SELECT customer_id FROM CustomerCollections WHERE collection_id=?").get(library.id).customer_id, customer.customer.id);
    assert.throws(() => restored.source("owned", { credentials: true }), { status: 423 });
    assert.equal((await restoredAuth.login({ username: "restore-customer", password }, "new-peer")).customer.id, customer.customer.id);
    assert.deepEqual(restored.collection(library.id).sourceIds, ["owned"]);
    assert.equal(restored.source("owned", { credentials: true }).configuration.password, "protected-upstream");
    assert.equal(auth.verify(customer.token).customer.id, customer.customer.id, "The running database must not be changed");
    const backupDb = new (require("better-sqlite3"))(backup, { readonly: true });
    try { assert.equal(backupDb.prepare("SELECT count(*) n FROM CustomerSessions").get().n, 1); }
    finally { backupDb.close(); }
  } finally { if (restoredAuth) await restoredAuth.close(); restored?.close(); await auth.close(); graph.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("schema twelve upgrades account storage without assigning existing admin sources to customers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-customer-migrate-")), filename = path.join(dir, "graph.db");
  let graph = new MediaGraph(filename, { secret });
  try {
    graph.addSource({ id: "admin-source", name: "Admin", protocol: "fixture", configuration: { password: "private-upstream" } });
    const [id] = graph.ingest("admin-source", [{ type: "movie", sourceKey: "owned", title: "Owned" }]);
    const synthetic = graph.synthetic("xtream", id), canonical = graph.media(id).canonicalId;
    const collection = graph.createCollection({ name: "Admin library", sourceIds: ["admin-source"] });
    graph.db.exec("DROP TABLE CustomerOutputLinks; DROP TABLE CustomerVaults; DROP TABLE CustomerSources; DROP TABLE CustomerCollections; DROP TABLE CustomerSessions; DROP TABLE CustomerAuthAttempts; DROP TABLE Customers; PRAGMA user_version=12");
    graph.close(); graph = new MediaGraph(filename, { secret });
    assert.equal(graph.db.pragma("user_version", { simple: true }), 16);
    assert.equal(graph.fromSynthetic("xtream", synthetic).canonicalId, canonical);
    assert.equal(graph.collection(collection.id).sourceIds[0], "admin-source");
    assert.equal(graph.sql("SELECT count(*) n FROM CustomerSources").get().n, 0);
    assert.equal(graph.sql("SELECT count(*) n FROM CustomerCollections").get().n, 0);
    const { snapshot } = require("../backup.cjs");
    assert.equal((await snapshot(filename, path.join(dir, "verified.db"), { secret })).schema, 16);
    graph.db.exec("DROP TABLE CustomerSessions");
    await assert.rejects(snapshot(filename, path.join(dir, "invalid.db"), { secret }), /Not a Boss database/);
  } finally { graph.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("customer HTTP provides cookie login, CSRF, recovery and logout without email or admin access", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-customer-http-"));
  let runtime;
  try {
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, "0.0.0.0", resolve)); const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}/bossmedia`, origin = new URL(base).origin;
    Object.assign(process.env, { DATA_DIR: dir, BOSS_ADMIN_TOKEN: "customer-test-admin-token", BOSS_SECRET: secret, PUBLIC_BASE_URL: base, BOSS_CUSTOMER_ACCOUNTS: "true" });
    runtime = require("../server"); await runtime.ready;
    await new Promise(resolve => runtime.server.listen(port, "0.0.0.0", resolve));
    const post = (route, input, extra = {}) => fetch(`${base}/account/${route}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...extra }, body: JSON.stringify(input) });
    assert.equal((await fetch(`${base}/account/me`)).status, 401);
    assert.equal((await post("register", { username: "http-user", password }, { Origin: "https://unrelated.example" })).status, 403);
    assert.equal((await post("register", { username: "http-user", password, email: "not-needed@example.com" })).status, 400);
    const created = await post("register", { username: "http-user", password }); assert.equal(created.status, 201);
    const cookie = created.headers.get("set-cookie").split(";", 1)[0], registration = await created.json();
    assert.match(created.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.match(created.headers.get("set-cookie"), /Path=\/bossmedia\//);
    assert.equal(registration.token, undefined); assert.ok(registration.csrfToken && registration.recoveryCode);
    assert.equal(created.headers.get("cache-control"), "private, no-store");
    const me = await fetch(`${base}/account/me`, { headers: { Cookie: cookie } }); assert.equal(me.status, 200);
    assert.equal((await me.json()).customer.username, "http-user");
    assert.deepEqual(await (await fetch(`${base}/api/addons`, { headers: { Cookie: cookie } })).json(), { addons: [] });
    assert.equal((await fetch(`${base}/api/identity-reviews`, { headers: { Cookie: cookie } })).status, 403, "Customer sessions must not become admin credentials");
    const otherResponse = await post("register", { username: "other-customer", password });
    const other = await otherResponse.json(), graph = runtime.engine.graph;
    const adminSource = "a".repeat(48), otherSource = "b".repeat(48);
    for (const [id, customerId] of [[adminSource, undefined], [otherSource, other.customer.id]]) {
      graph.addSource({ id, name: "Private source", protocol: "fixture", configuration: {}, customerId });
      graph.createCollection({ id, name: "Private library", sourceIds: [id], customerId });
      graph.ingest(id, [{ type: "movie", title: "Private movie", sourceKey: "movie" }]);
    }
    const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-Boss-CSRF": registration.csrfToken };
    for (const id of [adminSource, otherSource]) {
      for (const method of ["GET", "POST", "DELETE"]) assert.equal((await fetch(`${base}/api/addons/${id}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) })).status, 404);
      assert.equal((await fetch(`${base}/api/libraries/${id}`, { method: "DELETE", headers })).status, 404);
      assert.equal((await fetch(`${base}/api/libraries/${id}/outputs/jellyfin`, { method: "POST", headers })).status, 404);
      assert.equal((await fetch(`${base}/api/libraries`, { method: "POST", headers, body: JSON.stringify({ name: "Not mine", sourceIds: [id] }) })).status, 404);
    }
    assert.equal((await fetch(`${base}/api/probe`, { method: "POST", headers, body: JSON.stringify({ sourceType: "webdav", name: "Local", baseUrl: "http://127.0.0.1/" }) })).status, 403);
    assert.deepEqual((await (await fetch(`${base}/api/catalogue-status`, { headers })).json()).counts, { movie: 0, series: 0, channel: 0 });
    assert.equal((await (await fetch(`${base}/api/addons`, { headers: { "X-Boss-Admin": process.env.BOSS_ADMIN_TOKEN } })).json()).addons.length, 2);
    const { capabilities } = require("../core/model");
    runtime.engine.registry.factories.set("boss", source => ({ id: source.id, capabilities: capabilities({ catalog: true, streams: true, types: ["movie"] }),
      catalogs: [{ key: "movies", type: "movie", enumerable: true }], async catalog() { return { items: [{ type: "movie", sourceKey: "mine", title: "My movie" }], nextCursor: null }; },
      async resolve() { return [{ url: "http://127.0.0.1/private-service.mp4" }]; } }));
    const connected = await fetch(`${base}/api/addons`, { method: "POST", headers, body: JSON.stringify({ sourceType: "boss", name: "Owned source", baseUrl: "https://owned.example.invalid/addon.boss", customerId: other.customer.id }) });
    assert.equal(connected.status, 201);
    const source = (await connected.json()).addon;
    await runtime.engine.ingestSource(source.id);
    assert.equal(graph.sql("SELECT customer_id FROM CustomerSources WHERE source_id=?").get(source.id).customer_id, registration.customer.id);
    assert.equal(graph.sql("SELECT customer_id FROM CustomerCollections WHERE collection_id=?").get(source.id).customer_id, registration.customer.id);
    const ownedList = await (await fetch(`${base}/api/addons`, { headers })).json();
    assert.deepEqual(ownedList.addons.map(value => value.id), [source.id]);
    const media = runtime.engine.page({ sourceIds: [source.id], types: ["movie"] })[0];
    const nativeRoot = source.bossUrl.replace(/\/addon.boss$/, "");
    assert.equal((await fetch(`${nativeRoot}/play/${media.canonicalId}`)).status, 404, "Internal customer IDs are not public playback links");
    const mergedResponse = await fetch(`${base}/api/libraries`, { method: "POST", headers, body: JSON.stringify({ name: "My merged library", sourceIds: [source.id], customerId: other.customer.id }) });
    assert.equal(mergedResponse.status, 201);
    const merged = (await mergedResponse.json()).library;
    assert.notEqual(source.xtream.username, source.id);
    assert.notEqual(merged.xtream.username, merged.id);
    assert.match(merged.xtream.username, /^[a-f0-9]{64}$/);
    assert.equal((await fetch(`${base}/a/${source.id}/addon.boss`)).status, 404, "Internal customer IDs are not bearer links");
    const legacyPassword = require("node:crypto").createHmac("sha256", require("node:crypto").createHash("sha256").update(secret).digest()).update(`xtream:${source.id}`).digest("hex").slice(0, 32);
    assert.equal((await fetch(`${source.xtream.server}/player_api.php?${new URLSearchParams({ username: source.id, password: legacyPassword })}`)).status, 404);
    const adminHeaders = { "X-Boss-Admin": process.env.BOSS_ADMIN_TOKEN };
    const adminListing = await (await fetch(`${base}/api/addons`, { headers: adminHeaders })).json();
    assert.equal(adminListing.addons.find(item => item.id === source.id).bossUrl, undefined);
    assert.equal(adminListing.addons.find(item => item.id === source.id).xtream, undefined);
    assert.ok(adminListing.addons.find(item => item.id === adminSource).bossUrl, "Administrator-only links remain available");
    assert.equal((await fetch(`${base}/api/addons/${source.id}`, { headers: adminHeaders })).status, 403);
    assert.equal((await fetch(`${base}/api/libraries/${merged.id}/installation/rotate`, { method: "POST", headers: adminHeaders })).status, 403);
    assert.equal((await fetch(`${base}/api/libraries/${otherSource}/installation/rotate`, { method: "POST", headers })).status, 404);
    assert.equal((await fetch(`${base}/api/libraries/${merged.id}/installation/rotate`, { method: "POST", headers: { ...headers, "X-Boss-CSRF": "wrong" } })).status, 403);
    const installationRoutes = library => {
      const root = library.bossUrl.replace(/\/addon.boss$/, ""), params = new URLSearchParams({ username: library.xtream.username, password: library.xtream.password });
      return [library.bossUrl, library.compatibilityUrl, library.playlistUrl, `${root}/xmltv.xml`, `${root}/boss/catalogue`,
        `${library.xtream.server}/player_api.php?${params}`, `${library.xtream.server}/get.php?${params}`, `${library.xtream.server}/xmltv.php?${params}`];
    };
    for (const route of installationRoutes(merged)) { const response = await fetch(route); assert.equal(response.status, 200); await response.arrayBuffer(); }
    const rotatedResponse = await fetch(`${base}/api/libraries/${merged.id}/installation/rotate`, { method: "POST", headers });
    assert.equal(rotatedResponse.status, 200);
    const rotated = (await rotatedResponse.json()).library;
    assert.equal(rotated.id, merged.id); assert.notEqual(rotated.bossUrl, merged.bossUrl);
    assert.notEqual(rotated.xtream.password, merged.xtream.password);
    for (const route of installationRoutes(merged)) { const response = await fetch(route); assert.equal(response.status, 401); await response.arrayBuffer(); }
    for (const route of installationRoutes(rotated)) { const response = await fetch(route); assert.equal(response.status, 200); await response.arrayBuffer(); }
    const nativeDescriptor = await (await fetch(rotated.bossUrl)).json();
    assert.ok(!JSON.stringify(nativeDescriptor).includes(`/a/${rotated.id}/`), "Generated native child URLs must carry the public token");
    assert.equal(graph.sql("SELECT customer_id FROM CustomerCollections WHERE collection_id=?").get(merged.id).customer_id, registration.customer.id);
    assert.equal((await fetch(`${base}/api/libraries/${merged.id}`, { method: "POST", headers, body: JSON.stringify({ name: "Invalid membership", revision: merged.revision, sourceIds: [source.id, otherSource] }) })).status, 404);
    assert.deepEqual(graph.collection(merged.id).sourceIds, [source.id]);
    assert.equal((await fetch(`${base}/api/libraries/${merged.id}`, { method: "POST", headers: { ...headers, "X-Boss-CSRF": "wrong" }, body: JSON.stringify({ name: "Changed", revision: merged.revision, sourceIds: [source.id] }) })).status, 403);
    const outputParams = new URLSearchParams({ username: source.xtream.username, password: source.xtream.password });
    const outputRoutes = [source.bossUrl, source.compatibilityUrl, source.playlistUrl, `${nativeRoot}/xmltv.xml`,
      `${nativeRoot}/boss/catalogue`, `${source.xtream.server}/player_api.php?${outputParams}`,
      `${source.xtream.server}/get.php?${outputParams}`, `${source.xtream.server}/xmltv.php?${outputParams}`];
    assert.equal((await post("lock", {}, { Cookie: cookie, "X-Boss-CSRF": registration.csrfToken })).status, 200);
    for (const route of outputRoutes) {
      const locked = await fetch(route); assert.equal(locked.status, 423); await locked.arrayBuffer();
    }
    const unlocked = await post("login", { username: "http-user", password });
    assert.equal(unlocked.status, 200); assert.equal((await unlocked.json()).vault.unlocked, true);
    for (const route of outputRoutes) {
      const active = await fetch(route); assert.equal(active.status, 200); await active.arrayBuffer();
    }
    graph.sql("UPDATE Customers SET enabled=0 WHERE id=?").run(registration.customer.id);
    assert.equal(graph.collection(merged.id), null); assert.throws(() => graph.source(source.id), { status: 423 });
    assert.equal((await fetch(source.bossUrl)).status, 404);
    assert.throws(() => graph.updateSource(source.id, { name: "Renamed while owner disabled" }), { status: 423 });
    assert.equal(graph.sql("SELECT enabled FROM Sources WHERE id=?").get(source.id).enabled, 1);
    graph.sql("UPDATE Customers SET enabled=1 WHERE id=?").run(registration.customer.id);
    assert.equal((await post("login", { username: "http-user", password })).status, 200);
    assert.equal(graph.source(source.id).enabled, true);
    assert.equal((await fetch(`${base}/api/libraries/${merged.id}`, { method: "DELETE", headers })).status, 200);
    assert.equal((await fetch(`${base}/api/addons/${source.id}`, { method: "DELETE", headers })).status, 200);
    assert.equal((await post("logout", {}, { Cookie: cookie })).status, 403);
    assert.equal((await post("logout", {}, { Cookie: cookie, "X-Boss-CSRF": "invalid" })).status, 403);
    const logout = await post("logout", {}, { Cookie: cookie, "X-Boss-CSRF": registration.csrfToken });
    assert.equal(logout.status, 200); assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await fetch(`${base}/account/me`, { headers: { Cookie: cookie } })).status, 401);
    const logged = await post("login", { username: "http-user", password }); assert.equal(logged.status, 200);
    const loggedCookie = logged.headers.get("set-cookie").split(";", 1)[0];
    const refreshed = await post("login", { username: "http-user", password }, { Cookie: loggedCookie });
    assert.equal(refreshed.status, 200); assert.equal((await refreshed.json()).vault.unlocked, true);
    const freshCookie = refreshed.headers.get("set-cookie").split(";", 1)[0];
    assert.equal((await (await fetch(`${base}/account/me`, { headers: { Cookie: freshCookie } })).json()).vault.unlocked, true, "Replacing a cookie must not lock the newly authenticated vault");
    assert.equal((await fetch(`${base}/account/me`, { headers: { Cookie: `${loggedCookie}; ${loggedCookie}` } })).status, 401);
    const recoveredPassword = `${password} recovered`;
    const recovered = await post("recover", { username: "http-user", recoveryCode: registration.recoveryCode, password: recoveredPassword });
    assert.equal(recovered.status, 200);
    const recoveredBody = await recovered.json(); assert.match(recoveredBody.recoveryCode, /^boss-recovery-/);
    assert.equal(recoveredBody.removedSourceIds, undefined);
    assert.equal((await fetch(`${base}/account/me`, { headers: { Cookie: freshCookie } })).status, 401);
    assert.equal((await post("login", { username: "http-user", password })).status, 401);
    assert.equal((await post("login", { username: "http-user", password: recoveredPassword })).status, 200);
    const disposableResponse = await post("register", { username: "delete-http-user", password });
    const disposable = await disposableResponse.json(), disposableCookie = disposableResponse.headers.get("set-cookie").split(";", 1)[0];
    const deletionHeaders = { Cookie: disposableCookie, "X-Boss-CSRF": disposable.csrfToken };
    assert.equal((await post("delete", { password, confirmation: "delete" }, deletionHeaders)).status, 400);
    const deleted = await post("delete", { password, confirmation: "DELETE" }, deletionHeaders);
    assert.equal(deleted.status, 200); assert.match(deleted.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await fetch(`${base}/account/me`, { headers: { Cookie: disposableCookie } })).status, 401);
    assert.equal((await post("login", { username: "delete-http-user", password })).status, 401);
    process.env.BOSS_CUSTOMER_ACCOUNTS = "false";
    assert.equal((await post("register", { username: "another-user", password })).status, 404);
  } finally {
    if (runtime) { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); await runtime.close(); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

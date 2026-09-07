"use strict";
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { MediaEngine } = require("./core/engine");
const { OutputLibrary } = require("./protocols/library");
const { createAddonOutput, descriptorFile } = require("./protocols/addon");
const { normalizeAddonConfig } = require("./sources/addon");
const { createXtreamOutput } = require("./protocols/xtream");
const { createBossOutput, archiveContext } = require("./protocols/boss");
const { playlist, xmltv } = require("./protocols/m3u");
const { httpMedia } = require("./stream-policy");
const { redirectPlayback } = require("./core/direct-resource");
const { AuthLimit } = require("./core/auth-limit");
const adminAttempts = new AuthLimit();
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) for (const [key, value] of Object.entries(require("node:util").parseEnv(fs.readFileSync(envFile, "utf8")))) if (process.env[key] === undefined) process.env[key] = value;
const PORT = Number(process.env.PORT || 3000);
const BASE = (process.env.BASE_PATH || "/bossmedia").replace(/\/$/, "");
const PUBLIC = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}${BASE}`).replace(/\/$/, "");
const ADMIN = process.env.BOSS_ADMIN_TOKEN, SECRET = process.env.BOSS_SECRET;
const clientPeer = require("./core/client-peer").createClientPeer(process.env.BOSS_TRUSTED_PROXY_IPS || "");
if (!ADMIN || ADMIN.length < 10 || !SECRET || SECRET.length < 32) throw new Error("BOSS_ADMIN_TOKEN (at least 10 characters) and BOSS_SECRET (at least 32 characters) are required");
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const engine = new MediaEngine(path.join(dataDir, "boss.db"), { secret: SECRET });
const graph = engine.graph;
const outputLinks = new (require("./core/output-links").CustomerOutputLinks)(graph);
const refreshScheduler = new (require("./core/catalogue-refresh").CatalogueRefresh)(engine);
let refreshTimer;
const names = { jellyfin: "Jellyfin", emby: "Emby", plex: "Plex", boss: "Boss addon", catalogue: "Catalogue source", webdav: "WebDAV", xtream: "Xtream", m3u: "M3U", other: "Other source" };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const tasks = new Map();
let stopping = false;
let jellyfinHttp;
let customerHttp;
let developerMcp;
function customerAccounts() {
  if (process.env.BOSS_CUSTOMER_ACCOUNTS !== "true") throw fail("Not found", 404);
  customerHttp ||= require("./protocols/customer-http").createCustomerHttp({ graph, baseUrl: PUBLIC, basePath: BASE, body, json, peer: clientPeer,
    onDelete: sourceIds => { for (const id of sourceIds) engine.registry.invalidate(id); } });
  return customerHttp;
}
function jellyfinOutput() {
  if (process.env.BOSS_JELLYFIN_OUTPUT !== "true") throw fail("Not found", 404);
  jellyfinHttp ||= require("./protocols/jellyfin-http").createJellyfinHttp({ graph, library, json, body, handoff, baseUrl: `${PUBLIC}/jellyfin`, serverId: crypto.createHmac("sha256", SECRET).update("jellyfin-server").digest("hex").slice(0, 32) });
  return jellyfinHttp;
}
function sync(id, refresh = false) {
  if (stopping) throw fail("Server is shutting down", 503);
  if (!tasks.has(id)) tasks.set(id, engine.ingestSource(id, { refresh }).catch(() => {}).finally(() => tasks.delete(id)));
  return tasks.get(id);
}
function credentials(id) {
  if (customerLibrary(id)) {
    const { username, password } = outputLinks.credentials(id);
    return { server: `${PUBLIC}/xtream`, username, password };
  }
  legacyLibrary(id);
  return legacyCredentials(id);
}
function legacyCredentials(id) {
  return { server: `${PUBLIC}/xtream`, username: id, password: crypto.createHmac("sha256", crypto.createHash("sha256").update(SECRET).digest()).update(`xtream:${id}`).digest("hex").slice(0, 32) };
}
function customerLibrary(id) { return Boolean(graph.sql("SELECT 1 FROM CustomerCollections WHERE collection_id=?").get(id)); }
function legacyLibrary(id) {
  const collection = typeof id === "string" && graph.collection(id);
  if (!collection || customerLibrary(id)) throw fail("Library not found or revoked", 404);
  if (collection.sourceIds.some(sourceId => graph.sourceOwner(sourceId))) throw fail("Customer sources require an owned customer library", 409);
  return id;
}
function publicToken(id) { return customerLibrary(id) ? outputLinks.credentials(id).token : legacyLibrary(id); }
function publicLibrary(token) {
  if (typeof token === "string" && (token.length !== 64 || graph.collection(token))) return legacyLibrary(token);
  return outputLinks.resolve(token);
}
function publicCollection(collection, viewerId = null) {
  const owner = graph.sql("SELECT customer_id FROM CustomerCollections WHERE collection_id=?").get(collection.id)?.customer_id;
  if (owner && owner !== viewerId) return { ...collection };
  const record = owner && outputLinks.row(collection.id);
  if (record && record.customer_revision !== graph.sql("SELECT revision FROM Customers WHERE id=?").get(owner).revision) return { ...collection, installationRevoked: true };
  const root = `${PUBLIC}/a/${publicToken(collection.id)}`;
  return { ...collection, bossUrl: `${root}/addon.boss`, compatibilityUrl: `${root}/${descriptorFile}`, installUrl: `${root}/${descriptorFile}`, playlistUrl: `${root}/playlist.m3u`, xtream: credentials(collection.id) };
}
function publicSource(source, viewerId = null) {
  const collection = graph.collection(source.id);
  return { id: source.id, name: source.name, sourceType: source.protocol, createdAt: new Date(source.createdAt).toISOString(), capabilities: source.capabilities, syncing: tasks.has(source.id) || engine.sourceTasks.has(source.id), sync: graph.sql("SELECT status,phase,error_code,updated_at FROM SourceSync WHERE source_id=?").get(source.id) || null, jobs: graph.sql("SELECT catalog_key,status,imported_count,error_code FROM IngestionJobs WHERE source_id=?").all(source.id), ...(collection ? publicCollection(collection, viewerId) : {}) };
}
const ready = (async () => {
  const legacy = path.join(dataDir, "addons.json");
  if (fs.existsSync(legacy)) for (const row of JSON.parse(await fsp.readFile(legacy, "utf8")).addons || []) {
    if (graph.source(row.token)) continue;
    const source = graph.secrets.open(row.config);
    graph.db.transaction(() => {
      graph.addSource({ id: row.token, protocol: source.sourceType, name: source.name, configuration: source });
      graph.createCollection({ id: row.token, name: source.name, sourceIds: [row.token] });
    })();
  }
  for (const source of graph.startupSources()) sync(source.id);
})();
function equal(a, b) {
  const left = Buffer.from(String(a || "")), right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function json(res, status, data) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  res.end(JSON.stringify(data));
}
async function send(req, res, iterable, contentType) {
  const iterator = iterable[Symbol.asyncIterator]();
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  res.once("close", disconnected);
  try {
    const first = await iterator.next();
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "private, no-store", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" });
    if (req.method === "HEAD") return res.end();
    let part = first;
    while (!part.done && !res.destroyed) {
      if (!res.write(part.value)) await once(res, "drain", { signal: controller.signal });
      part = await iterator.next();
    }
    res.end();
  } finally { res.off("close", disconnected); await iterator.return?.(); }
}
async function body(req, form = false) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32768) throw fail("Request too large", 413); chunks.push(chunk); }
  const text = Buffer.concat(chunks).toString();
  try { return form ? new URLSearchParams(text) : JSON.parse(text); } catch { throw fail("Invalid request body"); }
}
function validate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.hasOwn(names, raw.sourceType)) throw fail("Choose a supported source type");
  raw = normalizeAddonConfig(raw);
  if (!httpMedia(raw.baseUrl)) throw fail("Enter an HTTP or HTTPS source URL without embedded credentials");
  if (["jellyfin", "emby", "plex"].includes(raw.sourceType) && !raw.apiKey) throw fail("An API key or access token is required");
  if (raw.sourceType === "xtream" && (!raw.username || !raw.password)) throw fail("Xtream credentials are required");
  for (const field of ["xmltvUrl", "addonUrl"]) if (raw[field] && !httpMedia(raw[field])) throw fail("Invalid source URL");
  const configuration = {};
  for (const field of ["baseUrl", "addonUrl", "apiKey", "userId", "username", "password", "libraryPath", "xmltvUrl", "mediaType"]) configuration[field] = String(raw[field] || "");
  configuration.baseUrl = configuration.baseUrl.replace(/\/$/, "");
  configuration.enableCatchup = raw.sourceType === "xtream" && raw.enableCatchup === true;
  return { name: String(raw.name || names[raw.sourceType]).slice(0, 80), protocol: raw.sourceType, configuration };
}
function editSource(id, raw) {
  const source = graph.source(id, { credentials: true });
  if (raw.revision !== source.revision) throw fail("Source changed. Reload before saving.", 409);
  if (raw.sourceType && raw.sourceType !== source.protocol) throw fail("Source protocol cannot be changed");
  const merged = { ...source.configuration, ...raw, name: raw.name ?? source.name, sourceType: source.protocol };
  for (const key of ["apiKey", "username", "password"]) {
    if (raw.replaceCredentials === true) merged[key] = String(raw[key] || "");
    else if (!raw[key]) merged[key] = source.configuration[key] || "";
  }
  const input = validate(merged);
  const before = normalizeAddonConfig(source.configuration).addonUrl || source.configuration.baseUrl;
  const after = input.configuration.addonUrl || input.configuration.baseUrl;
  const hasCredentials = ["apiKey", "username", "password"].some((key) => source.configuration[key]);
  if (hasCredentials && new URL(before).origin !== new URL(after).origin && raw.replaceCredentials !== true) throw fail("Replace credentials explicitly when changing the server origin");
  return input;
}
async function probeSource(input) {
  const factory = engine.registry.factories.get(input.protocol);
  const adapter = await factory({ id: crypto.randomUUID(), revision: 0, ...input });
  const catalog = adapter.catalogs?.find((entry) => entry.enumerable);
  let scan;
  try {
    let page = { items: [] };
    if (catalog) {
      const context = { key: catalog.key, limit: 5, signal: AbortSignal.timeout(15000) };
      scan = adapter.scanCatalog?.(context);
      page = scan ? (await scan.next()).value : await adapter.catalog(context);
    }
    return { ok: true, count: page.items.length, sample: page.items.map((item) => ({ name: item.title, type: item.type })) };
  } finally { await scan?.return?.(); }
}
function library(id) {
  const collection = graph.collection(id);
  if (!collection?.sourceIds.length) throw fail("Library not found or revoked", 404);
  const token = publicToken(id), root = `${PUBLIC}/a/${token}`;
  const authorize = () => { if (customerLibrary(id)) { if (outputLinks.resolve(token) !== id) throw fail("Installation link revoked", 401); } else legacyLibrary(id); };
  return new OutputLibrary(engine, collection, {
    authorize,
    play: (media) => `${root}/play/${media.canonicalId}`,
    artwork: (media, kind) => `${root}/artwork/${media.canonicalId}/${kind}`,
    resource: (resource, sourceId) => { authorize(); return ticket(id, sourceId, resource, undefined, token); }, epg: `${root}/xmltv.xml`, boss: `${root}/addon.boss`
  });
}
function ticket(collectionId, sourceId, resource, expires = Date.now() + 3600000, token = publicToken(collectionId)) {
  return `${PUBLIC}/a/${token}/resource/${require("./core/resource-ticket").sealTicket(graph, collectionId, sourceId, resource, expires)}`;
}
function handoff(req, res, lib, sourceId, resource, expires, _mediaPlayback = false, constraints = {}) {
  if (!lib.collection.sourceIds.includes(sourceId)) throw fail("Source access revoked", 403);
  const revision = graph.source(sourceId)?.revision;
  const collectionRevision = lib.collection.revision;
  constraints.authorize?.();
  if (expires && expires <= Date.now() || lib.collection.revision !== collectionRevision || !lib.collection.sourceIds.includes(sourceId) || graph.source(sourceId)?.revision !== revision) throw fail("Source access revoked", 403);
  return redirectPlayback(req, res, { url: resource.url, requiredHeaders: resource.headers || resource.requiredHeaders || {} });
}
async function play(req, res, lib, media, context = {}) {
  const capabilities = require("./core/player-capabilities").parseCapabilities(new URL(req.url, "http://boss.internal").searchParams);
  const protocols = require("./core/playback-context").playbackProtocols(new URL(req.url, "http://boss.internal").searchParams);
  const result = await lib.resolve(media, { output: "http", protocols, ...capabilities, ...context });
  const candidate = result.candidates.find(item => !Object.keys(item.requiredHeaders || {}).length) || result.candidates[0];
  if (!candidate) throw fail("No playable resource is available", 422);
  lib.collection;
  return redirectPlayback(req, res, { url: candidate.resource.url });
}
async function route(req, res) {
  await ready;
  const url = new URL(req.url, "http://boss.internal");
  if (url.pathname === `${BASE}/mcp`) {
    developerMcp ||= require("./core/developer-mcp").createDeveloperMcp({ publicUrl: PUBLIC });
    return developerMcp(req, res);
  }
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,HEAD,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,X-Boss-Admin,Range,Authorization,X-Emby-Authorization,X-Emby-Token" }); return res.end(); }
  if (url.pathname === BASE) { res.writeHead(302, { Location: `${BASE}/` }); return res.end(); }
  if (!url.pathname.startsWith(`${BASE}/`)) throw fail("Not found", 404);
  const pathname = url.pathname.slice(BASE.length);
  if (pathname === "/healthz") return json(res, 200, { ok: true, name: "boss-media-servers", port: PORT, architecture: "canonical-graph" });
  if (pathname.startsWith("/account/")) return customerAccounts().handle(req, res, pathname.slice("/account".length));
  if (pathname.startsWith("/api/")) {
    let customerId;
    if (!req.headers["x-boss-admin"] && process.env.BOSS_CUSTOMER_ACCOUNTS === "true" && customerAccounts().token(req)) {
      customerId = customerAccounts().session(req, !["GET", "HEAD"].includes(req.method)).customer.id;
      res.setHeader("X-Boss-Customer", customerId);
      if (req.headers["x-boss-customer"] && req.headers["x-boss-customer"] !== customerId) throw fail("Account session changed; sign in again", 409);
      customerAccounts().auth.management(customerId, !["GET", "HEAD"].includes(req.method));
    } else {
      const peer = clientPeer(req);
      const retry = adminAttempts.check(peer);
      if (retry) { res.setHeader("Retry-After", String(retry)); throw fail("Too many failed admin attempts. Try again after the cooldown.", 429); }
      if (!equal(req.headers["x-boss-admin"], ADMIN)) { adminAttempts.failed(peer); throw fail("Enter your admin token to manage sources.", 401); }
      adminAttempts.succeeded(peer);
    }
    const ownedSources = () => customerId ? graph.sql("SELECT source_id id FROM CustomerSources WHERE customer_id=? ORDER BY source_id").all(customerId).map(row => graph.source(row.id)) : graph.sources();
    const ownSource = id => {
      const owner = graph.sourceOwner(id);
      if (customerId && owner !== customerId) throw fail("Source not found", 404);
      if (!customerId && owner) throw fail("Customer owner authentication required", 403);
    };
    const ownLibrary = id => {
      const owner = graph.sql("SELECT customer_id FROM CustomerCollections WHERE collection_id=?").get(id)?.customer_id;
      if (customerId && owner !== customerId) throw fail("Library not found", 404);
      if (!customerId && owner) throw fail("Customer owner authentication required", 403);
    };
    const allowedSources = ids => {
      if (customerId) graph.customerSources(customerId, ids);
      else if (ids.some(id => graph.sourceOwner(id))) throw fail("Customer sources require owner authentication", 403);
    };
    const publicEndpoints = input => {
      if (customerId) for (const field of ["baseUrl", "addonUrl", "xmltvUrl"]) if (input.configuration[field]) require("./core/network").assertUrl(input.configuration[field]);
      return input;
    };
    const outputAccount = pathname.match(/^\/api\/libraries\/([a-f0-9]+)\/outputs\/jellyfin$/);
    const rotateLinks = pathname.match(/^\/api\/libraries\/([a-f0-9]+)\/installation\/rotate$/);
    if (rotateLinks && req.method === "POST") {
      ownLibrary(rotateLinks[1]);
      if (!customerId) throw fail("Customer owner authentication required", 403);
      outputLinks.rotate(rotateLinks[1]);
      return json(res, 200, { library: publicCollection(graph.collection(rotateLinks[1]), customerId) });
    }
    if (outputAccount && req.method === "POST") {
      ownLibrary(outputAccount[1]);
      const adapter = jellyfinOutput();
      const credentials = url.searchParams.get("rotate") === "true" ? adapter.auth.rotate(outputAccount[1], "jellyfin") : adapter.auth.provision(outputAccount[1], "jellyfin");
      return json(res, 201, { ...credentials, server: `${PUBLIC}/jellyfin`, experimental: true, playback: library(outputAccount[1]).capabilities.streams });
    }
    if (pathname === "/api/identity-reviews" && req.method === "GET") {
      if (customerId) throw fail("Administrator access required", 403);
      const after = Number(url.searchParams.get("after") || 0);
      return json(res, 200, require("./core/identity-review").reviewPage(graph, after));
    }
    if (pathname === "/api/catalogue-status" && req.method === "GET") {
      const sourceIds = customerId && ownedSources().filter(source => source.enabled).map(source => source.id);
      return json(res, 200, customerId ? { counts: Object.fromEntries(["movie", "series", "channel"].map(type => [type, graph.count({ sourceIds, types: [type] })])) } : refreshScheduler.status());
    }
    if (pathname === "/api/playback-evidence" && req.method === "GET") return json(res, 200, customerId ? graph.sql(`SELECT count(*) resources,COALESCE(sum(successful_transfers),0) successfulTransfers,COALESCE(sum(probes),0) probes,COALESCE(sum(failures),0) failures,COALESCE(sum(interruptions),0) interruptions
      FROM PlaybackEvidence WHERE source_id IN (SELECT source_id FROM CustomerSources WHERE customer_id=?)`).get(customerId) : engine.resolver.evidence.summary());
    if (pathname === "/api/addons" && req.method === "GET") return json(res, 200, { addons: ownedSources().map(source => publicSource(source, customerId)) });
    if (pathname === "/api/libraries" && req.method === "GET") {
      const rows = customerId ? graph.sql("SELECT collection_id id FROM CustomerCollections WHERE customer_id=? ORDER BY collection_id").all(customerId) : graph.sql("SELECT id FROM Collections").all();
      return json(res, 200, { libraries: rows.map(row => graph.collection(row.id)).filter(Boolean).map(collection => publicCollection(collection, customerId)) });
    }
    if (pathname === "/api/libraries" && req.method === "POST") {
      const input = await body(req);
      if (!Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.some((id) => !graph.source(id)?.enabled)) throw fail("Choose enabled sources");
      allowedSources(input.sourceIds);
      return json(res, 201, { library: publicCollection(graph.createCollection({ name: String(input.name || "Boss Media").slice(0, 80), sourceIds: input.sourceIds, profile: input.profile, customerId }), customerId) });
    }
    const collectionRoute = pathname.match(/^\/api\/libraries\/([a-f0-9]+)$/);
    if (collectionRoute) ownLibrary(collectionRoute[1]);
    if (collectionRoute && req.method === "POST") {
      if (graph.source(collectionRoute[1])) throw fail("Default source libraries cannot be edited");
      const input = await body(req);
      if (!Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.some((id) => !graph.source(id)?.enabled)) throw fail("Choose enabled sources");
      allowedSources(input.sourceIds);
      if (!String(input.name || "").trim()) throw fail("Library name is required");
      return json(res, 200, { library: publicCollection(graph.updateCollection(collectionRoute[1], { name: String(input.name).trim().slice(0, 80), sourceIds: input.sourceIds, revision: input.revision, profile: input.profile }), customerId) });
    }
    if (collectionRoute && req.method === "DELETE") {
      if (graph.source(collectionRoute[1])) throw fail("Remove the source to revoke its default library");
      graph.sql("DELETE FROM Collections WHERE id=?").run(collectionRoute[1]);
      return json(res, 200, { ok: true });
    }
    if (["/api/addons", "/api/probe"].includes(pathname) && req.method === "POST") {
      const input = publicEndpoints(validate(await body(req)));
      if (pathname === "/api/probe") return json(res, 200, await require("./core/network").scoped(Boolean(customerId), () => probeSource(input)));
      if (graph.sql("SELECT count(*) n FROM Sources").get().n >= 1000) throw fail("Server source capacity has been reached", 409);
      const source = await engine.addSource({ ...input, id: crypto.randomBytes(24).toString("hex"), customerId });
      try { graph.createCollection({ id: source.id, name: source.name, sourceIds: [source.id], customerId }); }
      catch (error) { graph.removeSource(source.id); engine.registry.invalidate(source.id); throw error; }
      sync(source.id);
      return json(res, 201, { addon: publicSource(source, customerId) });
    }
    const sourceRoute = pathname.match(/^\/api\/addons\/([a-f0-9]+)(\/(?:sync|probe))?$/);
    if (sourceRoute) ownSource(sourceRoute[1]);
    if (sourceRoute && graph.source(sourceRoute[1])) {
      const id = sourceRoute[1];
      if (!sourceRoute[2] && req.method === "GET") {
        const source = graph.source(id, { credentials: true });
        const configuration = normalizeAddonConfig(source.configuration);
        for (const key of ["apiKey", "username", "password"]) delete configuration[key];
        return json(res, 200, { source: { id, name: source.name, sourceType: source.protocol, revision: source.revision, configuration } });
      }
      if (sourceRoute[2] === "/sync" && req.method === "POST") { sync(id, true); return json(res, 202, { ok: true }); }
      if (req.method === "POST" && sourceRoute[2] !== "/sync") {
        const input = publicEndpoints(editSource(id, await body(req)));
        if (sourceRoute[2] === "/probe") return json(res, 200, await require("./core/network").scoped(Boolean(customerId), () => probeSource(input)));
        if (tasks.has(id) || [...engine.ingestor.running.keys()].some((key) => key.startsWith(`${id}:`))) throw fail("Wait for source sync to finish before editing", 409);
        graph.db.transaction(() => {
          graph.updateSource(id, input);
          graph.renameCollection(id, input.name);
          graph.sql("UPDATE CollectionRevisions SET revision=revision+1 WHERE collection_id=?").run(id);
        })();
        engine.registry.invalidate(id);
        sync(id, true);
        return json(res, 200, { addon: publicSource(graph.source(id), customerId) });
      }
      if (!sourceRoute[2] && req.method === "DELETE") { graph.removeSource(sourceRoute[1]); graph.sql("DELETE FROM Collections WHERE id=?").run(sourceRoute[1]); engine.registry.invalidate(sourceRoute[1]); return json(res, 200, { ok: true }); }
    }
    throw fail("Not found", 404);
  }
  if (pathname.startsWith("/xtream/")) {
    if (!["GET", "HEAD", "POST"].includes(req.method)) throw fail("Method not allowed", 405);
    const params = new URLSearchParams(url.searchParams);
    if (req.method === "POST") for (const [key, value] of await body(req, true)) {
      if (Object.values(require("./core/player-capabilities").PARAMETERS).includes(key)) params.append(key, value);
      else params.set(key, value);
    }
    const media = pathname.match(/^\/xtream\/(live|movie|series)\/([^/]+)\/([^/]+)\/(\d+)\.(mp4|mkv|webm|mov|m4v|avi|mpg|mpeg|ts|m3u8|m2ts|mts|ogv|flv|3gp)$/i);
    if (media && process.env.BOSS_PLAYBACK_LOG === "true") res.bossPlaybackTrace = require("./core/playback-trace").playbackTrace(req, res, media[1].toLowerCase(), media[4]);
    const archive = pathname.match(/^\/xtream\/timeshift\/([^/]+)\/([^/]+)\/(\d+)\/(\d{4}-\d{2}-\d{2}:\d{2}[-:]\d{2})\/(\d+)\.(ts|m3u8)$/);
    const username = media ? media[2] : archive ? archive[1] : params.get("username");
    const password = media ? media[3] : archive ? archive[2] : params.get("password");
    let id;
    if (typeof username === "string" && (username.length !== 64 || graph.collection(username))) {
      if (!equal(password, legacyCredentials(username).password)) throw fail("Invalid player credentials", 401);
      id = legacyLibrary(username);
    } else id = outputLinks.authenticate(username, password);
    const lib = library(id), output = createXtreamOutput(lib, credentials(id));
    if (pathname === "/xtream/boss_api") {
      const native = createBossOutput(lib, `${PUBLIC}/a/${publicToken(id)}`);
      const action = params.get("action") || "describe";
      if (action === "describe") return json(res, 200, native.descriptor());
      if (action === "categories") return json(res, 200, native.categories(params));
      if (["catalogue", "search"].includes(action)) {
        if (action === "search" && !params.get("search")?.trim()) throw fail("A search query is required");
        return json(res, 200, await native.catalogue(params));
      }
      if (["media", "playback", "subtitles"].includes(action)) return json(res, 200, await native[action](params.get("id"), params));
      if (action === "catchup") return json(res, 200, await native.catchup(params.get("id"), params));
      throw fail("Unsupported Boss action");
    }
    if (archive) {
      const value = archive[4];
      const iso = `${value.slice(0, 10)}T${value.slice(11, 13)}:${value.slice(14, 16)}:00.000Z`;
      const start = Date.parse(iso), duration = Number(archive[3]);
      if (!Number.isFinite(start) || new Date(start).toISOString() !== iso || duration < 1 || duration > 1440) throw fail("Invalid archive interval");
      return play(req, res, lib, output.media(archive[5], "live"), { ...require("./core/player-capabilities").parseCapabilities(params), start, end: start + duration * 60000, format: archive[6] });
    }
    if (media) return play(req, res, lib, output.media(media[4], media[1]), { ...require("./core/player-capabilities").parseCapabilities(params), format: media[5].toLowerCase() });
    if (pathname === "/xtream/player_api.php") return send(req, res, output.render(params), "application/json");
    if (pathname === "/xtream/get.php") return send(req, res, playlist(lib, credentials(id)), "audio/x-mpegurl");
    if (pathname === "/xtream/xmltv.php") return send(req, res, xmltv(lib), "application/xml");
    throw fail("Not found", 404);
  }
  if (pathname.startsWith("/jellyfin/")) return jellyfinOutput().handle(req, res, url, pathname.slice("/jellyfin".length));
  const addon = pathname.match(/^\/a\/([a-f0-9]+)\/(.+)$/);
  if (addon) {
    if (!["GET", "HEAD"].includes(req.method)) throw fail("Method not allowed", 405);
    const lib = library(publicLibrary(addon[1])), rest = addon[2];
    const boss = createBossOutput(lib, `${PUBLIC}/a/${addon[1]}`);
    if (rest === "addon" || rest === "addon.boss") {
      if (rest === "addon.boss") res.setHeader("Content-Disposition", 'attachment; filename="addon.boss"');
      return json(res, 200, boss.descriptor());
    }
    if (rest === "boss/catalogue") return json(res, 200, await boss.catalogue(url.searchParams));
    if (rest === "boss/categories") return json(res, 200, boss.categories(url.searchParams));
    const native = rest.match(/^boss\/(media|playback|subtitles|catchup)\/([a-f0-9-]+)$/);
    if (native) return json(res, 200, await boss[native[1]](native[2], url.searchParams));
    if (rest === "playlist.m3u") return send(req, res, playlist(lib, credentials(lib.collectionId)), "audio/x-mpegurl");
    if (rest === "xmltv.xml") return send(req, res, xmltv(lib), "application/xml");
    const media = rest.match(/^play\/([a-f0-9-]+)$/);
    if (media) return play(req, res, lib, lib.media(media[1]), url.searchParams.has("start") || url.searchParams.has("end") ? archiveContext(url.searchParams) : {});
    const artwork = rest.match(/^artwork\/([a-f0-9-]+)\/(poster|backdrop|logo|thumbnail)$/);
    if (artwork) {
      const item = lib.media(artwork[1]), art = engine.artwork(item.id, lib.collection.sourceIds)[artwork[2]];
      if (!art) throw fail("Artwork not found", 404);
      return handoff(req, res, lib, art.sourceId, art.resource);
    }
    const resource = rest.match(/^resource\/([A-Za-z0-9_-]+)$/);
    if (resource) {
      const value = require("./core/resource-ticket").openTicket(graph, lib.collectionId, resource[1], url.searchParams);
      return handoff(req, res, lib, value.sourceId, value.resource, value.expires);
    }
    const output = createAddonOutput(lib);
    if (rest === descriptorFile) return json(res, 200, output.manifest);
    const match = rest.match(/^(catalog|meta|stream|subtitles)\/([^/]+)\/([^/]+?)(?:\/(.*))?\.json$/);
    if (match) {
      const [, name, type, id, extra] = match;
      if (name === "meta") return send(req, res, output.metadataBody(decodeURIComponent(id)), "application/json");
      return json(res, 200, await output.get(name, decodeURIComponent(type), decodeURIComponent(id), Object.fromEntries(new URLSearchParams(extra || ""))));
    }
    throw fail("Not found", 404);
  }
  if (req.method !== "GET") throw fail("Method not allowed", 405);
  if (["/admin/", "/workspace/"].includes(pathname)) { res.writeHead(302, { Location: `${BASE}${pathname.slice(0, -1)}` }); return res.end(); }
  const files = { "/": ["public/home.html", "text/html"], "/workspace": ["public/index.html", "text/html"], "/sdk": ["public/sdk.html", "text/html"], "/sdk/": ["public/sdk.html", "text/html"], "/sdk/styles.css": ["public/sdk.css", "text/css"], "/sdk/client.mjs": ["public/boss-client.mjs", "application/javascript"], "/app.js": ["public/app.js", "application/javascript"], "/styles.css": ["public/styles.css", "text/css"], "/home.css": ["public/home.css", "text/css"], "/home.js": ["public/home.js", "application/javascript"], "/icon.svg": ["public/icon.svg", "image/svg+xml"], "/lucide.js": ["node_modules/lucide/dist/umd/lucide.min.js", "application/javascript"] };
  Object.assign(files, { "/sdk/addons": ["public/addon-sdk.html", "text/html"], "/sdk/addons/": ["public/addon-sdk.html", "text/html"], "/sdk/boss-addon.mjs": ["public/boss-addon.mjs", "application/javascript"], "/sdk/addon-example.mjs": ["public/addon-example.mjs", "application/javascript"], "/sdk/addon-ecosystem.cjs": ["public/addon-ecosystem.cjs", "application/javascript"] });
  Object.assign(files, { "/admin": ["public/index.html", "text/html"], "/customer.js": ["public/customer.js", "application/javascript"] });
  if (!files[pathname]) throw fail("Not found", 404);
  const [file, type] = files[pathname];
  const data = await fsp.readFile(path.join(__dirname, file));
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
  res.end(type === "text/html" ? data.toString("utf8").replaceAll("/bossmedia/", `${BASE}/`) : data);
}
const server = http.createServer((req, res) => route(req, res).catch((error) => {
  if (!res.headersSent && error.status === 429 && Number.isSafeInteger(error.retryAfter)) res.setHeader("Retry-After", String(error.retryAfter));
  json(res, error.status || 502, { error: error.status ? error.message : "Source operation failed. Check source availability and credentials." });
}));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
async function close() { stopping = true; clearInterval(refreshTimer); refreshScheduler.stop(); await ready; await customerHttp?.close(); engine.shutdown.abort(); await refreshScheduler.pending; await engine.close(); }
if (require.main === module) {
  ready.then(() => server.listen(PORT, "0.0.0.0", () => console.log(`Boss Media Servers listening on 0.0.0.0:${PORT}${BASE}`))).catch(() => { console.error("Database initialization failed"); process.exit(1); });
  ready.then(() => {
    const tick = () => refreshScheduler.tick().catch(() => console.error("Catalogue refresh scheduler failed"));
    tick(); refreshTimer = setInterval(tick, 60000); refreshTimer.unref();
  });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
    stopping = true;
    server.close(() => close().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 20000).unref();
  });
}
module.exports = { server, engine, ready, close };

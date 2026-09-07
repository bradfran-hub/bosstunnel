"use strict";
const { MediaGraph } = require("./graph");
const { SourceRegistry } = require("./registry");
const { CatalogueIngestor } = require("./ingestion");
const { ResolverEngine } = require("./resolver");
const { createCaches, sourceCaches } = require("./cache");
const { createAddonSource } = require("../sources/addon");
const { createMediaServerSource } = require("../sources/media-server");
const { createXtreamSource } = require("../sources/xtream");
const { createM3uSource } = require("../sources/m3u");
const { createWebDavSource } = require("../sources/webdav");
const { createPlexSource } = require("../sources/plex");
const { createBossSource } = require("../sources/boss");
const { httpMedia } = require("../stream-policy");

class MediaEngine {
  constructor(databaseFile, options) {
    this.graph = new MediaGraph(databaseFile, options);
    this.caches = createCaches();
    this.registry = new SourceRegistry(this.graph);
    this.registry.register("other", (source) => createAddonSource(source, { caches: sourceCaches(this.graph, source.id, this.caches) }));
    this.registry.register("jellyfin", createMediaServerSource);
    this.registry.register("emby", createMediaServerSource);
    this.registry.register("xtream", createXtreamSource);
    this.registry.register("m3u", createM3uSource);
    this.registry.register("webdav", source => createWebDavSource(source, { caches: sourceCaches(this.graph, source.id, this.caches) }));
    this.registry.register("plex", createPlexSource);
    this.registry.register("boss", createBossSource);
    this.registry.register("catalogue", async (source) => {
      const adapter = await createAddonSource(source, { caches: sourceCaches(this.graph, source.id, this.caches) });
      return { ...adapter, capabilities: require("./model").capabilities({ ...adapter.capabilities, streams: false, subtitles: false, catchup: false, timeshift: false, identityNamespaces: [] }) };
    });
    this.ingestor = new CatalogueIngestor(this.graph, this.registry);
    this.resolver = new ResolverEngine(this.graph, this.registry);
    this.shutdown = new AbortController();
    this.metadataRequests = new Map();
    this.sourceTasks = new Map();
    this.subtitleRequests = new Set();
    this.searchRequests = new Map();
  }
  async addSource(input) {
    const id = this.graph.addSource(input);
    try {
      const adapter = await this.registry.get(id);
      this.graph.setCapabilities(id, adapter.capabilities);
      return this.graph.source(id);
    } catch (error) { this.graph.removeSource(id); this.registry.invalidate(id); throw error; }
  }
  ingestSource(id, options = {}) {
    this.shutdown.signal.throwIfAborted();
    try { this.graph.sourceAccess(id)?.assertCurrent(); }
    catch (error) { return Promise.reject(error); }
    if (!this.sourceTasks.has(id)) this.sourceTasks.set(id, this.runSource(id, options).finally(() => this.sourceTasks.delete(id)));
    return this.sourceTasks.get(id);
  }
  async runSource(id, { refresh = false, indexEpisodes = true } = {}) {
    this.graph.sourceAccess(id)?.assertCurrent();
    const state = (status, phase, error = null) => {
      if (this.graph.source(id)) this.graph.sql("INSERT INTO SourceSync VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET status=excluded.status,phase=excluded.phase,error_code=excluded.error_code,updated_at=excluded.updated_at").run(id, status, phase, error, this.graph.clock());
    };
    let phase = "discovery";
    state("running", phase);
    try {
      if (refresh) { this.caches.sourceResponses.invalidatePrefix(`${id}:`); this.registry.invalidate(id); }
      const adapter = await this.registry.get(id);
      this.shutdown.signal.throwIfAborted();
      this.graph.setCapabilities(id, adapter.capabilities);
      phase = "catalogue"; state("running", phase);
      const results = [];
      let failedCatalogs = 0;
      const availableCatalogs = (adapter.catalogs || []).filter(catalog => catalog.enumerable);
      const yearOf = catalog => /^\d{4}$/.test(catalog.fixedExtras?.genre || "") ? Number(catalog.fixedExtras.genre) : null;
      const recentOnly = this.graph.source(id)?.protocol === "catalogue" && availableCatalogs.some(catalog => yearOf(catalog) != null);
      const currentYear = new Date(this.graph.clock()).getUTCFullYear();
      const catalogs = recentOnly ? availableCatalogs.filter(catalog => yearOf(catalog) >= currentYear - 1 && yearOf(catalog) <= currentYear) : availableCatalogs;
      if (recentOnly) {
        const selected = JSON.stringify(catalogs.map(catalog => catalog.key));
        this.graph.sql(`UPDATE IngestionJobs SET status='pending',error_code='CATALOGUE_PAUSED' WHERE source_id=? AND status<>'complete'
          AND catalog_key IN (SELECT catalog_key FROM SourceCatalogs WHERE source_id=?) AND catalog_key NOT IN (SELECT value FROM json_each(?))`).run(id, id, selected);
      }
      for (const catalog of catalogs) {
        this.graph.sql("INSERT OR IGNORE INTO SourceCatalogs VALUES(?,?)").run(id, catalog.key);
        try { results.push(await this.ingestor.ingest(id, catalog, { refresh, retainMissing: recentOnly, signal: this.shutdown.signal })); }
        catch (error) {
          if (this.shutdown.signal.aborted || !this.graph.source(id)?.enabled || [401, 403, 429].includes(error.upstreamStatus || error.status || error.response?.status)) throw error;
          failedCatalogs++;
        }
      }
      if (!failedCatalogs && !recentOnly) this.retireCatalogs(id, availableCatalogs.map(catalog => catalog.key));
      if (refresh && catalogs.length && !failedCatalogs && !recentOnly && !this.graph.sql("SELECT 1 FROM IdentityReviews WHERE source_id=? LIMIT 1").get(id)) this.graph.db.transaction(() => require("./categories").retireLegacy(this.graph, id, catalogs.map(catalog => catalog.key)))();
      let episodeError;
      if (indexEpisodes && !adapter.episodesInCatalog && this.graph.source(id)?.protocol !== "catalogue" && adapter.capabilities.metadata && adapter.capabilities.types.includes("series")) {
        phase = "episodes"; state("running", phase);
        try { await this.indexEpisodes(id, refresh); }
        catch (error) { if (error.code !== "EPISODE_SYNC_PARTIAL") throw error; episodeError = error; }
      }
      if (adapter.capabilities.epg) { phase = "epg"; state("running", phase); await this.ingestEpg(id, adapter); }
      this.caches.catalogPages.clear();
      if (failedCatalogs) { phase = "catalogue"; throw Object.assign(new Error(`${failedCatalogs} catalogue feeds could not be imported`), { code: "CATALOGUE_SYNC_PARTIAL", failedCatalogs }); }
      if (episodeError) { phase = "episodes"; throw episodeError; }
      state("complete", indexEpisodes ? "complete" : "catalogue-and-guide");
      return results;
    } catch (error) {
      state("failed", phase, this.shutdown.signal.aborted ? "SYNC_INTERRUPTED" : ["IDENTITY_CONFLICT", "EPISODE_SYNC_PARTIAL", "CATALOGUE_SYNC_PARTIAL"].includes(error.code) ? error.code : "SYNC_FAILED");
      throw error;
    }
  }
  async indexEpisodes(sourceId, refresh) {
    let after = 0;
    let failed = 0;
    const revision = this.graph.source(sourceId).revision;
    while (true) {
      this.shutdown.signal.throwIfAborted();
      const series = this.page({ sourceIds: [sourceId], types: ["series"], after, limit: 100 });
      if (!series.length) break;
      for (const media of series) {
        this.shutdown.signal.throwIfAborted();
        const source = this.graph.source(sourceId);
        if (!source?.enabled || source.revision !== revision) throw new Error("Source changed during episode indexing");
        const previous = this.graph.sql("SELECT * FROM SeriesHydration WHERE source_id=? AND media_id=?").get(sourceId, media.id);
        if (!refresh && previous?.source_revision === revision && previous.updated_at > this.graph.clock() - 86400000) continue;
        try { await this.hydrate(media, this.graph.mappings(media.id, [sourceId]), { refresh }); }
        catch (error) {
          this.shutdown.signal.throwIfAborted();
          const current = this.graph.source(sourceId);
          if (!current?.enabled || current.revision !== revision) throw new Error("Source changed during episode indexing");
          if (error.code === "IDENTITY_CONFLICT") throw error;
          failed++;
          continue;
        }
        this.shutdown.signal.throwIfAborted();
        const current = this.graph.source(sourceId);
        if (!current?.enabled || current.revision !== revision) throw new Error("Source changed during episode indexing");
        this.graph.sql("INSERT INTO SeriesHydration VALUES(?,?,?,?) ON CONFLICT(source_id,media_id) DO UPDATE SET source_revision=excluded.source_revision,updated_at=excluded.updated_at").run(sourceId, media.id, revision, this.graph.clock());
      }
      after = series.at(-1).id;
    }
    if (failed) throw Object.assign(new Error(`${failed} series could not be indexed; other series were processed`), { code: "EPISODE_SYNC_PARTIAL", status: 502, failedSeries: failed });
  }
  page(context) {
    const key = JSON.stringify([this.graph.revision, context]);
    const hit = this.caches.catalogPages.get(key);
    if (hit) return structuredClone(hit);
    const page = this.graph.page(context);
    this.caches.catalogPages.set(key, structuredClone(page), 10000);
    return page;
  }
  async search(context) {
    this.shutdown.signal.throwIfAborted();
    const query = String(context.search || "").trim();
    if (!query || query.length > 200) throw Object.assign(new Error("Search must contain 1 to 200 characters"), { status: 400 });
    const sourceIds = [...new Set(context.sourceIds || [])];
    const target = Math.max(1, Number(context.offset) || 0) + Math.min(200, Number(context.limit) || 100);
    const tasks = [];
    for (const sourceId of sourceIds) {
      const source = this.graph.source(sourceId);
      if (!source?.enabled || !source.capabilities.search) continue;
      const key = `${sourceId}:${source.revision}:search:${JSON.stringify([query, context.types || []])}`;
      if (!this.searchRequests.has(key)) {
        const cache = sourceCaches(this.graph, sourceId, this.caches).sourceResponses;
        const task = this.resolver.limiter.run(async () => {
          const adapter = await this.registry.get(sourceId);
          const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15000)]);
          const state = Object.assign(Object.create(null), structuredClone(cache.get(key) || {}));
          const catalogs = (adapter.catalogs || []).filter((entry) => entry.searchable && (!context.types?.length || context.types.includes(entry.type)));
          if (catalogs.length > 256) throw new Error("Source exceeds 256 searchable catalogues");
          const failed = new Set();
          // Breadth first gives later feeds a chance before earlier feeds fetch more pages.
          for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
            for (const catalog of catalogs) {
              const progress = state[catalog.key] || { cursor: null, count: 0, complete: false };
              if (failed.has(catalog.key) || progress.complete || progress.count >= target) continue;
              signal.throwIfAborted();
              let page;
              try { page = await adapter.search({ key: catalog.key, query, cursor: progress.cursor, limit: 200, signal }); }
              catch { signal.throwIfAborted(); failed.add(catalog.key); continue; }
              signal.throwIfAborted();
              const current = this.graph.source(sourceId);
              if (!current?.enabled || current.revision !== source.revision) throw new Error("Source changed during search");
              if (!Array.isArray(page.items) || page.items.length > 200) throw new Error("Source exceeded search page contract");
              if (page.nextCursor != null && String(page.nextCursor) === progress.cursor) throw new Error("Non-advancing search cursor");
              this.graph.ingest(sourceId, page.items, { allowTitleFallback: Boolean(adapter.allowTitleFallback) });
              progress.count += page.items.length;
              progress.cursor = page.nextCursor == null ? null : String(page.nextCursor);
              progress.complete = progress.cursor == null;
              state[catalog.key] = progress;
              cache.set(key, state, 30000);
            }
          }
        }).finally(() => this.searchRequests.delete(key));
        this.searchRequests.set(key, task);
      }
      tasks.push(this.searchRequests.get(key));
    }
    await Promise.allSettled(tasks);
    this.shutdown.signal.throwIfAborted();
    return this.page({ ...context, sourceIds, search: query });
  }
  artwork(mediaId, sourceIds) {
    const accesses = sourceIds.map(id => this.graph.sourceAccess(id)).filter(Boolean);
    // Customer artwork can contain provider credentials. Keep it out of the
    // shared plaintext cache; the database resource is already vault-encrypted.
    if (accesses.length) return this.graph.artwork(mediaId, sourceIds);
    const key = JSON.stringify([this.graph.revision, mediaId, sourceIds]);
    const hit = this.caches.artwork.get(key);
    if (hit) return structuredClone(hit);
    const artwork = this.graph.artwork(mediaId, sourceIds);
    this.caches.artwork.set(key, structuredClone(artwork), 60000);
    return artwork;
  }
  synthetic(protocol, mediaId) {
    const key = JSON.stringify([protocol, mediaId]);
    const hit = this.caches.identity.get(key);
    if (hit) return hit;
    const id = this.graph.synthetic(protocol, mediaId);
    this.caches.identity.set(key, id, 300000);
    return id;
  }
  retireCatalogs(sourceId, keys) {
    this.graph.revision++;
    this.graph.db.transaction(() => {
      const retired = this.graph.sql("SELECT catalog_key FROM SourceCatalogs WHERE source_id=? AND catalog_key NOT IN (SELECT value FROM json_each(?))").all(sourceId, JSON.stringify(keys));
      for (const { catalog_key: key } of retired) {
        require("./categories").retire(this.graph, sourceId, key);
        this.graph.sql("UPDATE SourceMappings SET active=0 WHERE source_id=? AND media_id IN (SELECT media_id FROM CatalogMembership WHERE source_id=? AND catalog_key=?) AND NOT EXISTS(SELECT 1 FROM CatalogMembership cm WHERE cm.source_id=SourceMappings.source_id AND cm.media_id=SourceMappings.media_id AND cm.catalog_key<>?)").run(sourceId, sourceId, key, key);
        this.graph.sql("DELETE FROM IngestionJobs WHERE source_id=? AND catalog_key=?").run(sourceId, key);
        this.graph.sql("DELETE FROM SourceCatalogs WHERE source_id=? AND catalog_key=?").run(sourceId, key);
      }
      this.graph.sql("UPDATE SourceMappings SET active=0 WHERE source_id=? AND media_id IN (SELECT e.media_id FROM Episodes e JOIN SourceMappings child ON child.media_id=e.media_id AND child.source_id=? AND child.active=1 WHERE NOT EXISTS(SELECT 1 FROM SourceMappings parent WHERE parent.source_id=? AND parent.media_id=e.series_id AND parent.active=1))").run(sourceId, sourceId, sourceId);
    })();
  }
  async ingestEpg(id, adapter) {
    const source = this.graph.source(id), startedAt = Date.now(), job = require("node:crypto").randomUUID();
    if (!source?.enabled) throw new Error("Guide source is unavailable");
    this.graph.db.exec("CREATE TEMP TABLE IF NOT EXISTS GuideStage (job TEXT NOT NULL,channel_id INTEGER NOT NULL,source_key TEXT NOT NULL,title TEXT NOT NULL,description TEXT,starts_at INTEGER NOT NULL,ends_at INTEGER NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(job,channel_id,source_key),CHECK(ends_at>starts_at))");
    let batch = [];
    const save = () => this.graph.db.transaction(() => {
      for (const event of batch) {
        // Start at the guide index, not every movie/channel mapping in the provider.
        this.graph.sql("INSERT INTO GuideStage SELECT ?,sm.media_id,?,?,?,?,?,? FROM SourceGuideIDs g INDEXED BY SourceGuideIDs_lookup CROSS JOIN SourceMappings sm ON sm.source_id=g.source_id AND sm.source_type=g.source_type AND sm.source_key=g.source_key WHERE g.source_id=? AND g.epg_id=? AND sm.active=1 ON CONFLICT(job,channel_id,source_key) DO UPDATE SET title=excluded.title,description=excluded.description,starts_at=excluded.starts_at,ends_at=excluded.ends_at,metadata=excluded.metadata").run(job, event.sourceKey, event.title, event.description || "", event.startsAt, event.endsAt, JSON.stringify(event.metadata || {}), id, event.channelKey);
      }
    })();
    try {
      for await (const event of adapter.epg({ signal: this.shutdown.signal })) { this.shutdown.signal.throwIfAborted(); batch.push(event); if (batch.length >= 200) { save(); batch = []; } }
      this.shutdown.signal.throwIfAborted();
      if (batch.length) save();
      this.graph.db.transaction(() => {
        const current = this.graph.source(id);
        if (!current?.enabled || current.revision !== source.revision) throw new Error("Guide source changed during refresh");
        this.graph.sql("INSERT INTO EPGEvents(source_id,channel_id,source_key,title,description,starts_at,ends_at,metadata) SELECT ?,channel_id,source_key,title,description,starts_at,ends_at,metadata FROM GuideStage WHERE job=? ON CONFLICT(source_id,source_key,channel_id) DO UPDATE SET title=excluded.title,description=excluded.description,starts_at=excluded.starts_at,ends_at=excluded.ends_at,metadata=excluded.metadata").run(id, job);
        // Keep recent history for catch-up, but retire missing current/future programmes.
        this.graph.sql("DELETE FROM EPGEvents WHERE source_id=? AND (ends_at<? OR (ends_at>=? AND NOT EXISTS(SELECT 1 FROM GuideStage s WHERE s.job=? AND s.channel_id=EPGEvents.channel_id AND s.source_key=EPGEvents.source_key)))").run(id, startedAt - 30 * 86400000, startedAt, job);
      })();
    } finally { this.graph.sql("DELETE FROM GuideStage WHERE job=?").run(job); }
  }
  async metadata(mediaId, context) {
    const media = this.graph.media(mediaId);
    if (!media) throw Object.assign(new Error("Media not found"), { status: 404 });
    const mappings = this.graph.mappings(media.id, context.allowedSourceIds);
    if (!mappings.length) throw Object.assign(new Error("Media is outside this library"), { status: 404 });
    const key = JSON.stringify([media.id, mappings.map((mapping) => [mapping.sourceId, mapping.revision])]);
    const hit = this.caches.metadata.get(key);
    if (hit) return this.graph.media(media.id);
    if (this.metadataRequests.has(key)) return this.metadataRequests.get(key);
    const task = this.hydrate(media, mappings).finally(() => this.metadataRequests.delete(key));
    this.metadataRequests.set(key, task);
    const result = await task;
    this.caches.metadata.set(key, true, 60000);
    return result;
  }
  async hydrate(media, mappings, { refresh = false } = {}) {
    let successes = 0;
    let attempted = 0;
    for (const mapping of mappings) {
      try {
        this.shutdown.signal.throwIfAborted();
        attempted++;
        const adapter = await this.registry.get(mapping.sourceId);
        if (!adapter.capabilities.metadata) { attempted--; continue; }
        const result = await this.resolver.limiter.run(async () => {
          const controller = new AbortController();
          const signal = AbortSignal.any([this.shutdown.signal, controller.signal]);
          const timer = setTimeout(() => controller.abort(new Error("Metadata lookup timed out")), 15000);
          let abort;
          try {
            signal.throwIfAborted();
            const interrupted = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
            return await Promise.race([Promise.resolve().then(() => adapter.metadata(mapping, { media, signal })), interrupted]);
          } finally {
            clearTimeout(timer);
            if (abort) signal.removeEventListener("abort", abort);
            controller.abort();
          }
        });
        this.shutdown.signal.throwIfAborted();
        if (!result) continue;
        const current = this.graph.source(mapping.sourceId);
        if (!current?.enabled || current.revision !== mapping.revision) throw new Error("Source changed during metadata retrieval");
        this.graph.ingest(mapping.sourceId, [result]);
        if (Array.isArray(result.children)) {
          const generation = this.graph.sql("SELECT COALESCE(MAX(sm.seen_generation),0)+1 AS generation FROM SourceMappings sm JOIN Episodes e ON e.media_id=sm.media_id WHERE sm.source_id=? AND e.series_id=?").get(mapping.sourceId, media.id).generation;
          for (let start = 0; start < result.children.length; start += 200) this.graph.ingest(mapping.sourceId, result.children.slice(start, start + 200), { generation });
          if (media.type === "series") this.graph.sql("UPDATE SourceMappings SET active=0 WHERE source_id=? AND media_id IN (SELECT media_id FROM Episodes WHERE series_id=?) AND seen_generation<>?").run(mapping.sourceId, media.id, generation);
          this.graph.revision++;
        }
        for (const catalog of result.childCatalogs || []) await this.ingestor.ingest(mapping.sourceId, catalog, { refresh, signal: this.shutdown.signal });
        successes++;
      } catch (error) { this.shutdown.signal.throwIfAborted(); if (error.code === "IDENTITY_CONFLICT") throw error; }
    }
    if (attempted && !successes) throw Object.assign(new Error("Metadata sources are unavailable"), { status: 502 });
    return this.graph.media(media.id);
  }
  resolve(mediaId, context) { return this.resolver.resolve(mediaId, context); }
  subtitles(mediaId, context) {
    this.shutdown.signal.throwIfAborted();
    const task = this.loadSubtitles(mediaId, context).finally(() => this.subtitleRequests.delete(task));
    this.subtitleRequests.add(task);
    return task;
  }
  async loadSubtitles(mediaId, context) {
    context.signal?.throwIfAborted();
    const media = this.graph.media(mediaId);
    if (!media) throw Object.assign(new Error("Media not found"), { status: 404 });
    const mappings = this.graph.mappings(media.id, context.allowedSourceIds || []);
    if (!mappings.length) throw Object.assign(new Error("Media is outside this library"), { status: 404 });
    const results = [];
    for (const mapping of mappings) {
      context.signal?.throwIfAborted();
      if (results.length >= 200) break;
      try {
        const { abortable } = require("./abortable");
        const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15000), ...(context.signal ? [context.signal] : [])]);
        const adapter = await abortable(this.registry.get(mapping.sourceId), signal);
        if (!adapter.capabilities.subtitles) continue;
        const entries = await this.resolver.limiter.run(async () => {
          signal.throwIfAborted();
          return abortable(adapter.subtitles(media, mapping, { media, series: media.seriesId ? this.graph.media(media.seriesId) : undefined, signal }), signal);
        }, { signal });
        const source = this.graph.source(mapping.sourceId);
        if (!source?.enabled || source.revision !== mapping.revision) continue;
        for (const subtitle of Array.isArray(entries) ? entries.slice(0, 200 - results.length) : []) {
          const resource = subtitle.resource || { url: subtitle.url };
          if (!httpMedia(resource.url)) continue;
          results.push({ id: `${mapping.sourceId}:${String(subtitle.id || results.length)}`, language: subtitle.language || "und", resource, sourceId: mapping.sourceId, sourceRevision: source.revision });
        }
      } catch { this.shutdown.signal.throwIfAborted(); context.signal?.throwIfAborted(); }
    }
    return results;
  }
  async close() {
    this.shutdown.abort();
    this.resolver.limiter.close();
    await Promise.allSettled([...this.sourceTasks.values()]);
    await Promise.allSettled([...this.ingestor.running.values(), ...this.metadataRequests.values(), ...this.resolver.pending.values(), ...this.subtitleRequests, ...this.searchRequests.values()]);
    this.graph.close();
  }
}
module.exports = { MediaEngine };

"use strict";
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeMedia, titleKey, capabilities } = require("./model");
const { Secrets } = require("./secrets");
const { playbackProfile } = require("./profile");

class IdentityConflict extends Error {
  constructor(message) { super(message); this.name = "IdentityConflict"; this.code = "IDENTITY_CONFLICT"; }
}
class MediaGraph {
  constructor(filename, { secret, clock = Date.now } = {}) {
    this.clock = clock; this.secrets = new Secrets(secret); this.statements = new Map();
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -16384");
    this.db.pragma("temp_store = FILE");
    this.db.pragma("busy_timeout = 5000");
    const version = this.db.pragma("user_version", { simple: true });
    if (version > 10) throw new Error("Database schema is newer than this application");
    this.db.transaction(() => {
      this.db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
      if (version < 10) this.db.exec("INSERT INTO SourceMediaSearch(SourceMediaSearch) VALUES('rebuild')");
      if (version < 9) this.db.exec(`INSERT OR IGNORE INTO CategoryProvenance SELECT mc.media_id,mc.category_id,'','','["legacy"]',0 FROM MediaCategories mc`);
      if (!this.db.pragma("table_info(PlaybackEvidence)").some(column => column.name === "last_failure")) {
        // Legacy rows cannot establish event order; require fresh success after any recorded failure.
        this.db.exec("ALTER TABLE PlaybackEvidence ADD COLUMN last_failure INTEGER; UPDATE PlaybackEvidence SET last_failure=updated_at WHERE failures>0");
      }
      // The old channel-level guide ID is reliable only for a single source mapping.
      if (version < 7) this.db.exec("INSERT OR IGNORE INTO SourceGuideIDs SELECT sm.source_id,sm.source_type,sm.source_key,c.epg_id FROM SourceMappings sm JOIN Channels c ON c.media_id=sm.media_id WHERE c.epg_id IS NOT NULL AND (SELECT count(*) FROM SourceMappings other WHERE other.media_id=sm.media_id)=1");
    })();
    if (filename !== ":memory:") fs.chmodSync(filename, 0o600);
    this.revision = 0;
    this.ingest = this.db.transaction((sourceId, inputs, options = {}) => { this.revision++; return inputs.map((input) => this._upsert(sourceId, normalizeMedia(input), options)); });
  }
  sql(text) {
    if (!this.statements.has(text)) {
      if (this.statements.size >= 160) this.statements.delete(this.statements.keys().next().value);
      this.statements.set(text, this.db.prepare(text));
    }
    return this.statements.get(text);
  }
  close() { this.db.close(); }
  addSource({ id = crypto.randomUUID(), protocol, name, configuration, priority = 0, capabilities: declaration = {} }) {
    const now = this.clock();
    this.db.transaction(() => {
      this.sql("INSERT INTO Sources(id,protocol,name,configuration,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, protocol, name, this.secrets.seal(configuration), priority, now, now);
      this.setCapabilities(id, declaration);
    })();
    return id;
  }
  source(id, { credentials = false } = {}) {
    const row = this.sql("SELECT s.*,c.declaration FROM Sources s LEFT JOIN SourceCapabilities c ON c.source_id=s.id WHERE s.id=?").get(id);
    if (!row) return null;
    const result = { id: row.id, protocol: row.protocol, name: row.name, enabled: Boolean(row.enabled), priority: row.priority, revision: row.revision, capabilities: JSON.parse(row.declaration || "{}"), createdAt: row.created_at, updatedAt: row.updated_at };
    if (credentials) result.configuration = this.secrets.open(row.configuration);
    return result;
  }
  sources() { return this.sql("SELECT id FROM Sources ORDER BY priority DESC,id").all().map((row) => this.source(row.id)); }
  setCapabilities(id, declaration) {
    const normalized = capabilities(declaration);
    this.db.transaction(() => {
      this.sql("INSERT INTO SourceCapabilities VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET declaration=excluded.declaration,verified_at=excluded.verified_at").run(id, JSON.stringify(normalized), this.clock());
      this.sql("DELETE FROM ResolverMappings WHERE source_id=?").run(id);
      if (normalized.streams) for (const namespace of normalized.identityNamespaces) for (const type of normalized.types) this.sql("INSERT INTO ResolverMappings VALUES(?,?,?)").run(id, namespace, type);
    })();
  }
  updateSource(id, patch) {
    this.revision++;
    const source = this.source(id, { credentials: true });
    if (!source) throw new Error("Source not found");
    this.db.transaction(() => {
      this.sql("UPDATE Sources SET name=?,configuration=?,enabled=?,priority=?,revision=revision+1,updated_at=? WHERE id=?").run(patch.name ?? source.name, this.secrets.seal(patch.configuration ?? source.configuration), Number(patch.enabled ?? source.enabled), patch.priority ?? source.priority, this.clock(), id);
      if (patch.capabilities) this.setCapabilities(id, patch.capabilities);
      this.sql("DELETE FROM ResolutionCache WHERE source_id=?").run(id);
    })();
  }
  removeSource(id) { this.sql("DELETE FROM Sources WHERE id=?").run(id); this.revision++; }
  createCollection({ id = crypto.randomBytes(24).toString("hex"), name, sourceIds, profile }) {
    this.db.transaction(() => {
      this.sql("INSERT INTO Collections VALUES(?,?,?)").run(id, name, this.clock());
      this.sql("INSERT INTO CollectionRevisions(collection_id) VALUES(?)").run(id);
      this.sql("INSERT INTO CollectionProfiles VALUES(?,?)").run(id, JSON.stringify(playbackProfile(profile)));
      for (const sourceId of new Set(sourceIds)) this.sql("INSERT INTO CollectionSources VALUES(?,?)").run(id, sourceId);
    })();
    return this.collection(id);
  }
  collection(id) {
    const row = this.sql("SELECT c.*,r.revision,p.profile FROM Collections c JOIN CollectionRevisions r ON r.collection_id=c.id JOIN CollectionProfiles p ON p.collection_id=c.id WHERE c.id=?").get(id);
    return row ? { id: row.id, name: row.name, revision: row.revision, profile: playbackProfile(JSON.parse(row.profile)), createdAt: row.created_at, sourceIds: this.sql("SELECT cs.source_id FROM CollectionSources cs JOIN Sources s ON s.id=cs.source_id WHERE cs.collection_id=? AND s.enabled=1 ORDER BY s.priority DESC,s.id").all(id).map((r) => r.source_id) } : null;
  }
  updateCollection(id, { name, sourceIds, revision, profile }) {
    this.db.transaction(() => {
      const current = this.collection(id);
      if (!current) throw Object.assign(new Error("Library not found"), { status: 404 });
      if (revision !== current.revision) throw Object.assign(new Error("Library changed. Reload before saving."), { status: 409 });
      this.sql("UPDATE Collections SET name=? WHERE id=?").run(name, id);
      this.sql("UPDATE CollectionProfiles SET profile=? WHERE collection_id=?").run(JSON.stringify(playbackProfile(profile || current.profile)), id);
      this.sql("DELETE FROM CollectionSources WHERE collection_id=?").run(id);
      for (const sourceId of new Set(sourceIds)) this.sql("INSERT INTO CollectionSources VALUES(?,?)").run(id, sourceId);
      this.sql("UPDATE CollectionRevisions SET revision=revision+1 WHERE collection_id=?").run(id);
    })();
    return this.collection(id);
  }
  canonicalRow(id) {
    let row = this.sql(typeof id === "number" ? "SELECT * FROM MediaItems WHERE id=?" : "SELECT * FROM MediaItems WHERE canonical_id=?").get(id);
    let depth = 0;
    while (row?.merged_into) { if (++depth > 100) throw new Error("Invalid canonical alias chain"); row = this.sql("SELECT * FROM MediaItems WHERE id=?").get(row.merged_into); }
    return row;
  }
  _upsert(sourceId, input, { generation = 0, allowTitleFallback = false, catalogKey } = {}) {
    const source = this.source(sourceId);
    if (!source) throw new Error("Source not found");
    if (["season", "episode"].includes(input.type)) {
      const reference = input.seriesRef;
      const mapping = reference && this.sql("SELECT media_id FROM SourceMappings WHERE source_id=? AND source_type=? AND source_key=? AND active=1").get(sourceId, reference.sourceType || "series", String(reference.sourceKey || ""));
      const parent = this.canonicalRow(reference ? mapping?.media_id || -1 : input.seriesId);
      if (parent?.type !== "series") throw new Error("Series child requires a canonical series");
      input = { ...input, seriesId: parent.id };
    }
    const mapped = this.sql("SELECT media_id FROM SourceMappings WHERE source_id=? AND source_type=? AND source_key=?").get(sourceId, input.sourceType, input.sourceKey);
    let target = mapped ? this.canonicalRow(mapped.media_id) : null;
    const candidates = [];
    for (const [namespace, value] of Object.entries(input.externalIDs)) {
      const hit = this.sql("SELECT media_id FROM ExternalIDs WHERE namespace=? AND kind=? AND external_id=?").get(namespace, input.type, value);
      if (hit) candidates.push(this.canonicalRow(hit.media_id));
    }
    if (!target && candidates.length) target = candidates[0];
    if (target && target.type !== input.type) throw new IdentityConflict("A source changed the type of an existing media identity");
    if (!target && input.type === "season") {
      const hit = this.sql("SELECT media_id FROM Seasons WHERE series_id=? AND number=?").get(input.seriesId, input.seasonNumber);
      if (hit) target = this.canonicalRow(hit.media_id);
    }
    if (!target && input.type === "episode") {
      const hit = this.sql("SELECT media_id FROM Episodes WHERE series_id=? AND season_number=? AND number=?").get(input.seriesId, input.seasonNumber, input.episodeNumber);
      if (hit) target = this.canonicalRow(hit.media_id);
    }
    if (!target && allowTitleFallback && ["movie", "series"].includes(input.type) && input.year) {
      const matches = this.sql("SELECT * FROM MediaItems WHERE type=? AND normalized_title=? AND year=? AND merged_into IS NULL LIMIT 2").all(input.type, titleKey(input.title), input.year);
      if (matches.length === 1 && !this.identityConflict(matches[0].id, input.externalIDs)) target = matches[0];
    }
    if (target && this.identityConflict(target.id, input.externalIDs)) throw new IdentityConflict("Conflicting reliable external identities require review");
    for (const candidate of candidates) if (candidate.id !== target.id) this.merge(target.id, candidate.id);
    if (target) target = this.canonicalRow(target.id);
    const now = this.clock();
    if (!target) {
      const inserted = this.sql("INSERT INTO MediaItems(canonical_id,type,title,normalized_title,metadata_priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(crypto.randomUUID(), input.type, input.title, titleKey(input.title), source.priority, now, now);
      target = this.canonicalRow(Number(inserted.lastInsertRowid));
    }
    const fields = { title: "title", originalTitle: "original_title", year: "year", description: "description", genres: "genres", runtimeSeconds: "runtime_seconds", rating: "rating", certification: "certification", releaseDate: "release_date" };
    const values = [];
    const assignments = [];
    for (const [field, column] of Object.entries(fields)) {
      if (input[field] === undefined || input[field] === null || input[field] === "") continue;
      if (source.priority < target.metadata_priority && target[column] != null && target[column] !== "[]" && target[column] !== "") continue;
      assignments.push(`${column}=?`); values.push(field === "genres" ? JSON.stringify(input[field]) : input[field]);
      if (field === "title") { assignments.push("normalized_title=?"); values.push(titleKey(input.title)); }
    }
    assignments.push("metadata_priority=?", "updated_at=?"); values.push(Math.max(source.priority, target.metadata_priority), now, target.id);
    this.sql(`UPDATE MediaItems SET ${assignments.join(",")} WHERE id=?`).run(...values);
    for (const [namespace, value] of Object.entries(input.externalIDs)) this.sql("INSERT INTO ExternalIDs VALUES(?,?,?,?) ON CONFLICT DO NOTHING").run(namespace, input.type, value, target.id);
    this.sql("INSERT INTO SourceMappings VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(source_id,source_type,source_key) DO UPDATE SET media_id=excluded.media_id,resolver_data=excluded.resolver_data,active=1,seen_generation=excluded.seen_generation,updated_at=excluded.updated_at").run(sourceId, input.sourceType, input.sourceKey, target.id, this.secrets.seal(input.resolverData || {}), generation, now);
    const metadata = Object.fromEntries(["type", "title", "originalTitle", "year", "description", "genres", "runtimeSeconds", "rating", "certification", "releaseDate", "externalIDs"].filter((field) => input[field] !== undefined).map((field) => [field, input[field]]));
    this.sql("INSERT INTO Metadata VALUES(?,?,?,?) ON CONFLICT(media_id,source_id) DO UPDATE SET document=excluded.document,updated_at=excluded.updated_at").run(target.id, sourceId, JSON.stringify(metadata), now);
    for (const [kind, resource] of Object.entries(input.artwork || {})) if (["poster", "backdrop", "logo", "thumbnail"].includes(kind) && resource) this.sql("INSERT INTO Artwork(media_id,source_id,kind,resource) VALUES(?,?,?,?) ON CONFLICT(media_id,source_id,kind) DO UPDATE SET resource=excluded.resource").run(target.id, sourceId, kind, this.secrets.seal(resource));
    require("./categories").replace(this, sourceId, input, target.id, catalogKey, generation);
    if (input.type === "movie") this.sql("INSERT OR IGNORE INTO Movies VALUES(?)").run(target.id);
    if (input.type === "series") this.sql("INSERT OR IGNORE INTO Series VALUES(?)").run(target.id);
    if (input.type === "season") {
      if (this.canonicalRow(input.seriesId)?.type !== "series") throw new Error("Season requires a canonical series");
      this.sql("INSERT INTO Seasons VALUES(?,?,?) ON CONFLICT(media_id) DO NOTHING").run(target.id, input.seriesId, input.seasonNumber);
    }
    if (input.type === "episode") {
      const parent = this.canonicalRow(input.seriesId);
      if (parent?.type !== "series") throw new Error("Episode requires a canonical series");
      const season = this._upsert(sourceId, normalizeMedia({ type: "season", sourceKey: `boss-season:${parent.canonical_id}:${input.seasonNumber}`, seriesId: parent.id, seasonNumber: input.seasonNumber, title: `${parent.title}: Season ${input.seasonNumber}` }), { generation });
      this.sql("INSERT INTO Episodes VALUES(?,?,?,?,?) ON CONFLICT(media_id) DO NOTHING").run(target.id, parent.id, season, input.seasonNumber, input.episodeNumber);
    }
    if (input.type === "channel") this.sql("INSERT INTO Channels VALUES(?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET number=coalesce(excluded.number,Channels.number),epg_id=coalesce(excluded.epg_id,Channels.epg_id),catchup_days=max(excluded.catchup_days,Channels.catchup_days),timeshift_seconds=max(excluded.timeshift_seconds,Channels.timeshift_seconds)").run(target.id, input.channel?.number || null, input.channel?.epgId || null, input.channel?.catchupDays || 0, input.channel?.timeshiftSeconds || 0);
    if (input.type === "channel" && input.channel && Object.hasOwn(input.channel, "epgId")) {
      if (input.channel.epgId) this.sql("INSERT INTO SourceGuideIDs VALUES(?,?,?,?) ON CONFLICT(source_id,source_type,source_key) DO UPDATE SET epg_id=excluded.epg_id").run(sourceId, input.sourceType || input.type, input.sourceKey, String(input.channel.epgId));
      else this.sql("DELETE FROM SourceGuideIDs WHERE source_id=? AND source_type=? AND source_key=?").run(sourceId, input.sourceType || input.type, input.sourceKey);
    }
    if (input.type === "event") this.sql("INSERT INTO LiveEvents VALUES(?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET channel_id=excluded.channel_id,starts_at=excluded.starts_at,ends_at=excluded.ends_at").run(target.id, input.event?.channelId || null, input.event?.startsAt || null, input.event?.endsAt || null);
    return target.id;
  }
  identityConflict(id, identities) {
    return this.sql("SELECT namespace,external_id FROM ExternalIDs WHERE media_id=?").all(id).some((row) => identities[row.namespace] && identities[row.namespace] !== row.external_id);
  }
  merge(keepId, removeId) {
    const keep = this.canonicalRow(keepId), remove = this.canonicalRow(removeId);
    if (keep.id === remove.id) return keep.id;
    if (keep.type !== remove.type || this.identityConflict(keep.id, Object.fromEntries(this.sql("SELECT namespace,external_id FROM ExternalIDs WHERE media_id=?").all(remove.id).map((r) => [r.namespace, r.external_id])))) throw new IdentityConflict("Canonical identities disagree");
    for (const column of ["title", "normalized_title", "original_title", "year", "description", "genres", "runtime_seconds", "rating", "certification", "release_date"]) {
      if (remove[column] != null && remove[column] !== "" && remove[column] !== "[]" && (remove.metadata_priority > keep.metadata_priority || keep[column] == null || keep[column] === "" || keep[column] === "[]")) this.sql(`UPDATE MediaItems SET ${column}=? WHERE id=?`).run(remove[column], keep.id);
    }
    this.sql("UPDATE MediaItems SET metadata_priority=max(metadata_priority,?),updated_at=? WHERE id=?").run(remove.metadata_priority, this.clock(), keep.id);
    // Child identities are merged before their parent so existing episode links survive.
    if (keep.type === "series") {
      for (const season of this.sql("SELECT * FROM Seasons WHERE series_id=?").all(remove.id)) {
        const hit = this.sql("SELECT * FROM Seasons WHERE series_id=? AND number=?").get(keep.id, season.number);
        if (hit) this.merge(hit.media_id, season.media_id);
        else this.sql("UPDATE Seasons SET series_id=? WHERE media_id=?").run(keep.id, season.media_id);
      }
      for (const episode of this.sql("SELECT * FROM Episodes WHERE series_id=?").all(remove.id)) {
        const hit = this.sql("SELECT media_id FROM Episodes WHERE series_id=? AND season_number=? AND number=?").get(keep.id, episode.season_number, episode.number);
        if (hit) this.merge(hit.media_id, episode.media_id);
        else this.sql("UPDATE Episodes SET series_id=? WHERE media_id=?").run(keep.id, episode.media_id);
      }
    }
    if (keep.type === "season") this.sql("UPDATE Episodes SET season_id=? WHERE season_id=?").run(keep.id, remove.id);
    for (const table of ["ExternalIDs", "Metadata", "Artwork", "MediaCategories", "CategoryProvenance", "CatalogMembership"]) {
      this.sql(`UPDATE OR IGNORE ${table} SET media_id=? WHERE media_id=?`).run(keep.id, remove.id);
      this.sql(`DELETE FROM ${table} WHERE media_id=?`).run(remove.id);
    }
    this.sql("UPDATE SourceMappings SET media_id=? WHERE media_id=?").run(keep.id, remove.id);
    this.sql("UPDATE SyntheticIDs SET media_id=? WHERE media_id=?").run(keep.id, remove.id);
    this.sql("DELETE FROM ResolutionCache WHERE media_id IN (?,?)").run(keep.id, remove.id);
    const subtype = { movie: "Movies", series: "Series", season: "Seasons", episode: "Episodes", channel: "Channels", event: "LiveEvents" }[remove.type];
    if (remove.type === "channel") { this.sql("UPDATE OR IGNORE EPGEvents SET channel_id=? WHERE channel_id=?").run(keep.id, remove.id); this.sql("DELETE FROM EPGEvents WHERE channel_id=?").run(remove.id); this.sql("UPDATE LiveEvents SET channel_id=? WHERE channel_id=?").run(keep.id, remove.id); }
    this.sql(`DELETE FROM ${subtype} WHERE media_id=?`).run(remove.id);
    this.sql("UPDATE MediaItems SET merged_into=? WHERE id=?").run(keep.id, remove.id);
    return keep.id;
  }
  media(id) {
    const row = this.canonicalRow(id);
    if (!row) return null;
    const externalIDs = Object.fromEntries(this.sql("SELECT namespace,external_id FROM ExternalIDs WHERE media_id=?").all(row.id).map((r) => [r.namespace, r.external_id]));
    const result = { id: row.id, canonicalId: row.canonical_id, type: row.type, title: row.title, originalTitle: row.original_title, year: row.year, description: row.description, genres: JSON.parse(row.genres), runtimeSeconds: row.runtime_seconds, rating: row.rating, certification: row.certification, releaseDate: row.release_date, externalIDs, updatedAt: row.updated_at, playbackState: "UNRESOLVED" };
    if (row.type === "episode") { const e = this.sql("SELECT * FROM Episodes WHERE media_id=?").get(row.id); result.seriesId = e.series_id; result.seasonId = e.season_id; result.seasonNumber = e.season_number; result.episodeNumber = e.number; }
    if (row.type === "season") { const s = this.sql("SELECT * FROM Seasons WHERE media_id=?").get(row.id); result.seriesId = s.series_id; result.seasonNumber = s.number; }
    if (row.type === "channel") result.channel = this.sql("SELECT number,epg_id AS epgId,catchup_days AS catchupDays,timeshift_seconds AS timeshiftSeconds FROM Channels WHERE media_id=?").get(row.id);
    return result;
  }
  page({ types = ["movie", "series", "channel", "event"], sourceIds, after = 0, offset = 0, limit = 100, search = "", seriesId, categoryId } = {}) {
    if (!Array.isArray(sourceIds) || !sourceIds.length) return [];
    const clauses = ["m.merged_into IS NULL", "m.id > @after", "m.type IN (SELECT value FROM json_each(@types))", "EXISTS(SELECT 1 FROM SourceMappings sm JOIN Sources s ON s.id=sm.source_id WHERE sm.media_id=m.id AND sm.active=1 AND s.enabled=1 AND s.id IN (SELECT value FROM json_each(@sources)))"];
    const params = { after, types: JSON.stringify(types), sources: JSON.stringify(sourceIds), limit: Math.max(1, Math.min(1000, limit)), offset: Math.max(0, offset) };
    if (categoryId != null) {
      if (!Number.isSafeInteger(categoryId) || categoryId < 0) return [];
      const membership = "SELECT mc.media_id FROM MediaCategories mc JOIN Categories c ON c.id=mc.category_id JOIN SourceMappings cm ON cm.media_id=mc.media_id AND cm.source_id=c.source_id JOIN Sources cs ON cs.id=c.source_id WHERE cm.active=1 AND cs.enabled=1 AND c.source_id IN (SELECT value FROM json_each(@sources))";
      if (categoryId === 0) clauses.push(`m.id NOT IN (${membership})`);
      else { clauses.push(`m.id IN (${membership} AND mc.category_id=@categoryId)`); params.categoryId = categoryId; }
    }
    if (seriesId) { clauses.push("m.id IN (SELECT media_id FROM Episodes WHERE series_id=@seriesId UNION SELECT media_id FROM Seasons WHERE series_id=@seriesId)"); params.seriesId = seriesId; }
    if (search.trim()) {
      const tokens = search.match(/[\p{L}\p{N}]+/gu) || [];
      if (!tokens.length) return [];
      clauses.push(`m.id IN (SELECT md.media_id FROM SourceMediaSearch JOIN Metadata md ON md.rowid=SourceMediaSearch.rowid JOIN Sources ss ON ss.id=md.source_id
        WHERE SourceMediaSearch MATCH @query AND ss.enabled=1 AND ss.id IN (SELECT value FROM json_each(@sources))
        AND EXISTS(SELECT 1 FROM SourceMappings sm WHERE sm.media_id=md.media_id AND sm.source_id=md.source_id AND sm.active=1))`);
      params.query = tokens.slice(0, 20).map(token => `"${token}"*`).join(" AND ");
    }
    return this.sql(`SELECT m.id FROM MediaItems m WHERE ${clauses.join(" AND ")} ORDER BY m.id LIMIT @limit OFFSET @offset`).all(params).map((row) => this.media(row.id));
  }
  mappings(mediaId, sourceIds) {
    if (!sourceIds?.length) return [];
    return this.sql("SELECT sm.*,s.priority,s.revision FROM SourceMappings sm JOIN Sources s ON s.id=sm.source_id WHERE sm.media_id=? AND sm.active=1 AND s.enabled=1 AND sm.source_id IN (SELECT value FROM json_each(?)) ORDER BY s.priority DESC,sm.source_id").all(mediaId, JSON.stringify(sourceIds)).map((row) => ({ sourceId: row.source_id, sourceType: row.source_type, sourceKey: row.source_key, resolverData: this.secrets.open(row.resolver_data), priority: row.priority, revision: row.revision }));
  }
  synthetic(protocol, mediaId) {
    return this.db.transaction(() => {
      const id = this.canonicalRow(mediaId)?.id;
      if (!id) throw new Error("Media not found");
      const row = this.sql("SELECT id FROM SyntheticIDs WHERE protocol=? AND media_id=? ORDER BY id LIMIT 1").get(protocol, id);
      return row ? row.id : Number(this.sql("INSERT INTO SyntheticIDs(protocol,media_id,created_at) VALUES(?,?,?)").run(protocol, id, this.clock()).lastInsertRowid);
    })();
  }
  fromSynthetic(protocol, id) { const row = this.sql("SELECT media_id FROM SyntheticIDs WHERE protocol=? AND id=?").get(protocol, id); return row ? this.media(row.media_id) : null; }
  artwork(mediaId, sourceIds) {
    const rows = this.sql("SELECT a.kind,a.resource,a.source_id FROM Artwork a JOIN Sources s ON s.id=a.source_id WHERE a.media_id=? AND s.enabled=1 AND a.source_id IN (SELECT value FROM json_each(?)) ORDER BY s.priority DESC,a.id").all(mediaId, JSON.stringify(sourceIds));
    const result = {};
    for (const row of rows) {
      const resource = this.secrets.open(row.resource);
      result[row.kind] ||= { sourceId: row.source_id, resource: typeof resource === "string" ? { url: resource } : resource };
    }
    return result;
  }
}
module.exports = { MediaGraph, IdentityConflict };

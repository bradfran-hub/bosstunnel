"use strict";
const crypto = require("node:crypto");
const { httpMedia } = require("../stream-policy");
const { WorkLimiter } = require("./limiter");
const { streamDetails } = require("./stream-details");

function expiry(value) {
  if (value == null || value === "") return undefined;
  if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value)) { const date = Date.parse(value); return Number.isFinite(date) ? date : undefined; }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? (number < 1e12 ? number * 1000 : number) : undefined;
}
function normalizeCandidate(raw, sourceId, now = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  if (["infoHash", "info_hash", "magnet", "torrent", "torrentUrl", "fileIdx", "sources"].some((field) => field in raw || (raw.resource && typeof raw.resource === "object" && field in raw.resource))) return null;
  if (raw.drm || raw.requiresDrm || raw.resource?.drm) return null;
  const resource = typeof raw.resource === "string" ? { url: raw.resource } : raw.resource || { url: raw.url };
  if (!httpMedia(resource.url)) return null;
  const parsed = new URL(resource.url);
  const expiresAt = expiry(raw.expiresAt) || expiry(parsed.searchParams.get("expires") || parsed.searchParams.get("exp") || parsed.searchParams.get("Expires"));
  if (expiresAt && expiresAt <= now + 1000) return null;
  const protocol = raw.protocol || (/\.m3u8(?:\?|$)/i.test(resource.url) ? "hls" : /\.mpd(?:\?|$)/i.test(resource.url) ? "dash" : "http");
  if (!["http", "hls", "dash"].includes(protocol)) return null;
  const headers = {};
  for (const [name, value] of Object.entries(raw.requiredHeaders || resource.headers || {})) {
    if (["authorization", "referer", "user-agent", "origin", "x-emby-token", "x-emby-authorization", "x-plex-token", "x-plex-client-identifier", "x-plex-product", "x-plex-version"].includes(name.toLowerCase()) && typeof value === "string" && !/[\r\n]/.test(value)) headers[name] = value;
  }
  const positive = value => Number.isFinite(value) && value > 0 ? value : undefined;
  const video = Object.fromEntries(["bitDepth", "level", "frameRate", "bitrate"].flatMap(key => positive(raw.video?.[key]) ? [[key, raw.video[key]]] : []));
  if (typeof raw.video?.profile === "string" && raw.video.profile.length <= 128) video.profile = raw.video.profile;
  return { sourceId, resource: { url: resource.url }, protocol, ...streamDetails(raw), container: raw.container ? String(raw.container).toLowerCase() : null, bitrate: positive(raw.bitrate) || null, video, audio: (Array.isArray(raw.audio) ? raw.audio : []).filter(track => track && typeof track === "object"), languages: Array.isArray(raw.languages) ? raw.languages.map(String) : [], subtitles: (Array.isArray(raw.subtitles) ? raw.subtitles : []).filter((subtitle) => httpMedia(subtitle.url)), requiredHeaders: headers, expiresAt: expiresAt || null, resolver: { kind: "resolved-http", ...(raw.resolver?.provider ? { provider: String(raw.resolver.provider) } : {}) } };
}
function compatible(candidate, context) {
  if (context.protocols?.length && !context.protocols.includes(candidate.protocol)) return false;
  if (context.codecs?.length && candidate.codec && !context.codecs.map((codec) => codec.toLowerCase()).includes(candidate.codec)) return false;
  if (context.containers?.length && candidate.container && !context.containers.includes(candidate.container)) return false;
  if (context.maxHeight && candidate.resolution?.height > context.maxHeight) return false;
  if (context.hdr === false && candidate.hdr) return false;
  if (context.strictCapabilities && ((context.codecs?.length && !candidate.codec) || (context.containers?.length && !candidate.container))) return false;
  return true;
}
function score(candidate, context, priority) {
  const preference = context.sourcePreference?.indexOf(candidate.sourceId) ?? -1;
  const sourceScore = preference >= 0 ? 10000 - preference * 100 : 0;
  const language = context.language && candidate.languages.some((language) => language.toLowerCase().split("-")[0] === context.language.toLowerCase().split("-")[0]) ? 1000 : 0;
  const height = Math.min(candidate.resolution?.height || 0, context.desiredHeight || context.maxHeight || 2160);
  return sourceScore + priority * 100 + language + height / 10;
}
class ResolverEngine {
  constructor(graph, registry, { clock = Date.now, concurrency = 4, timeoutMs = 15000, maxCacheEntries = 5000, globalConcurrency = 16, maxQueued = 128 } = {}) {
    this.graph = graph; this.registry = registry; this.clock = clock; this.concurrency = concurrency; this.timeoutMs = timeoutMs; this.maxCacheEntries = maxCacheEntries;
    this.evidence = new (require("./playback-evidence").PlaybackEvidence)(graph);
    this.pending = new Map();
    this.limiter = new WorkLimiter({ concurrency: globalConcurrency, maxQueued, waitMs: timeoutMs });
  }
  candidatesFor(media, allowedSourceIds) {
    const mappings = this.graph.mappings(media.id, allowedSourceIds);
    const found = new Set(mappings.map((mapping) => mapping.sourceId));
    const identity = media.type === "episode" ? this.graph.media(media.seriesId)?.externalIDs || {} : media.externalIDs;
    for (const sourceId of allowedSourceIds) {
      if (found.has(sourceId)) continue;
      const source = this.graph.source(sourceId);
      if (!source?.enabled || !source.capabilities.streams || !source.capabilities.types.includes(media.type)) continue;
      if (source.capabilities.identityNamespaces.some((namespace) => identity[namespace])) { mappings.push({ sourceId, sourceKey: null, sourceType: media.type, resolverData: {}, priority: source.priority, revision: source.revision }); found.add(sourceId); }
    }
    return mappings;
  }
  async resolve(mediaOrId, context = {}) {
    const media = this.graph.media(typeof mediaOrId === "object" ? mediaOrId.id : mediaOrId);
    if (!media) throw Object.assign(new Error("Media not found"), { status: 404 });
    if (context.start != null || context.end != null) {
      if (media.type !== "channel" || !Number.isFinite(context.start) || !Number.isFinite(context.end) || context.start < 0 || context.end <= context.start || context.end > this.clock() + 60000 || context.end - context.start > 86400000) throw Object.assign(new Error("Invalid archive interval"), { status: 400 });
    }
    if (!Array.isArray(context.allowedSourceIds) || !context.allowedSourceIds.length) throw Object.assign(new Error("No authorized playback sources"), { status: 403 });
    const accesses = [...new Set(context.allowedSourceIds)].map(id => this.graph.sourceAccess(id)).filter(Boolean);
    const sources = this.candidatesFor(media, [...new Set(context.allowedSourceIds)]);
    const results = []; const failures = []; let next = 0;
    const worker = async () => {
      while (next < sources.length) {
        const mapping = sources[next++];
        try {
          const candidates = await this.sourceCandidates(media, mapping, context);
          for (const candidate of candidates) if (compatible(candidate, context)) results.push({ candidate, revision: mapping.revision, score: score(candidate, context, mapping.priority) + this.evidence.bonus(media.id, candidate) });
        } catch { failures.push({ sourceId: mapping.sourceId, code: "SOURCE_RESOLUTION_FAILED" }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, sources.length) }, worker));
    for (const access of accesses) access.assertCurrent();
    // A source may be revoked while its network request is in flight.
    const candidates = results.filter((row) => { const source = this.graph.source(row.candidate.sourceId); return source?.enabled && source.revision === row.revision; }).sort((a, b) => b.score - a.score || a.candidate.sourceId.localeCompare(b.candidate.sourceId)).map((row) => row.candidate);
    const seen = new Set();
    const unique = candidates.filter(candidate => {
      const key = JSON.stringify([candidate.sourceId, candidate.resource.url, candidate.requiredHeaders]);
      if (seen.has(key) || candidate.expiresAt && candidate.expiresAt <= this.clock() + 1000) return false;
      seen.add(key); return true;
    });
    if (!unique.length) throw Object.assign(new Error("No compatible authorized HTTP streams are available"), { status: 422, failures });
    return { mediaId: media.id, selected: unique[0], candidates: unique, failures };
  }
  async sourceCandidates(media, mapping, context) {
    const access = this.graph.sourceAccess(mapping.sourceId);
    const contextKey = { output: context.output || "", protocols: context.protocols || [], codecs: context.codecs || [], containers: context.containers || [], language: context.language || "", maxHeight: context.maxHeight || 0, desiredHeight: context.desiredHeight || 0, hdr: context.hdr ?? null, strictCapabilities: Boolean(context.strictCapabilities), directPlay: context.directPlay !== false };
    if (context.start != null) { contextKey.start = context.start; contextKey.end = context.end; }
    const key = crypto.createHash("sha256").update(JSON.stringify(["choices-v1", media.id, mapping.sourceId, mapping.sourceType, mapping.sourceKey, mapping.revision, contextKey])).digest("hex");
    const cached = this.graph.sql("SELECT encrypted_result FROM ResolutionCache WHERE cache_key=? AND expires_at>?").get(key, this.clock());
    if (cached) return this.graph.sourceOpen(mapping.sourceId, "resolution-cache", key, cached.encrypted_result);
    if (this.pending.has(key)) { const result = await this.pending.get(key); access?.assertCurrent(); return result; }
    const task = this.limiter.run(() => { access?.assertCurrent(); return this.fetchCandidates(media, mapping, context, key, access); }, { signal: access?.signal });
    this.pending.set(key, task);
    try { const result = await task; access?.assertCurrent(); return result; } finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }
  invalidatePlayback(mediaId, failed) {
    // Compare resources so an older request cannot evict a newly refreshed URL.
    this.graph.db.transaction(() => {
      for (const sourceId of new Set(failed.map((candidate) => candidate.sourceId))) {
        const rows = this.graph.sql("SELECT cache_key,encrypted_result FROM ResolutionCache WHERE media_id=? AND source_id=?").all(mediaId, sourceId);
        for (const row of rows) {
          const cached = this.graph.sourceOpen(sourceId, "resolution-cache", row.cache_key, row.encrypted_result);
          if (cached.some((candidate) => failed.some((old) => old.sourceId === sourceId && old.resource.url === candidate.resource.url && JSON.stringify(old.requiredHeaders) === JSON.stringify(candidate.requiredHeaders)))) this.graph.sql("DELETE FROM ResolutionCache WHERE cache_key=?").run(row.cache_key);
        }
      }
    })();
  }
  async fetchCandidates(media, mapping, context, key, access) {
    const adapter = await this.registry.get(mapping.sourceId);
    access?.assertCurrent();
    if (!adapter.capabilities.streams) return [];
    const method = context.start == null ? "resolve" : "catchup";
    if (method === "catchup" && !adapter.capabilities.catchup) return [];
    const controller = new AbortController();
    let timeout;
    const timeoutPromise = new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("Source resolution timed out")); }, this.timeoutMs); });
    let raw;
    try { raw = await Promise.race([adapter[method](media, mapping.sourceKey == null ? null : mapping, { ...context, signal: controller.signal, series: media.type === "episode" ? this.graph.media(media.seriesId) : undefined }), timeoutPromise]); }
    finally { clearTimeout(timeout); }
    access?.assertCurrent();
    const now = this.clock();
    const normalized = (Array.isArray(raw) ? raw : []).slice(0, 200).map((candidate) => normalizeCandidate(candidate, mapping.sourceId, now)).filter(Boolean);
    const current = this.graph.source(mapping.sourceId);
    if (!current?.enabled || current.revision !== mapping.revision) return [];
    const ttl = Math.max(0, Math.min(adapter.resolutionTtlMs ?? 30000, 300000));
    const expiresAt = Math.min(now + ttl, ...normalized.filter((candidate) => candidate.expiresAt).map((candidate) => candidate.expiresAt - 5000));
    if (normalized.length && expiresAt > now) {
      this.graph.db.transaction(() => {
        this.graph.sql("DELETE FROM ResolutionCache WHERE expires_at<=?").run(now);
        this.graph.sql("INSERT INTO ResolutionCache VALUES(?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET encrypted_result=excluded.encrypted_result,expires_at=excluded.expires_at").run(key, media.id, mapping.sourceId, mapping.revision, this.graph.sourceSeal(mapping.sourceId, "resolution-cache", key, normalized), expiresAt);
        this.graph.sql("DELETE FROM ResolutionCache WHERE cache_key IN (SELECT cache_key FROM ResolutionCache ORDER BY expires_at DESC LIMIT -1 OFFSET ?)").run(this.maxCacheEntries);
      })();
    }
    return normalized;
  }
}
module.exports = { ResolverEngine, normalizeCandidate, compatible, expiry };

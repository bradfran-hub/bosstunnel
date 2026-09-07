"use strict";

const TYPES = Object.freeze(["movie", "series", "season", "episode", "channel", "event"]);
const CAPABILITIES = Object.freeze(["catalog", "metadata", "search", "streams", "subtitles", "live", "epg", "catchup", "timeshift"]);
const titleKey = (value) => String(value).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function capabilities(value = {}) {
  const result = Object.fromEntries(CAPABILITIES.map((key) => [key, value[key] === true]));
  result.types = Array.isArray(value.types) ? [...new Set(value.types.filter((type) => TYPES.includes(type)))] : [];
  result.identityNamespaces = Array.isArray(value.identityNamespaces) ? value.identityNamespaces.filter((namespace) => ["imdb", "tmdb", "tvdb"].includes(namespace)) : [];
  return Object.freeze(result);
}
function externalIDs(raw = {}) {
  const result = {};
  for (const namespace of ["imdb", "tmdb", "tvdb"]) {
    const value = String(raw[namespace] || "").trim();
    if (namespace === "imdb" ? /^tt\d{7,12}$/.test(value) : /^\d+$/.test(value) && Number(value) > 0) result[namespace] = value;
  }
  return result;
}
function normalizeMedia(raw) {
  if (!TYPES.includes(raw.type)) throw new TypeError("Unsupported canonical media type");
  if (!raw.title || !String(raw.title).trim()) throw new TypeError("Canonical media requires a title");
  if (!raw.sourceKey) throw new TypeError("Source mapping requires a stable source key");
  const result = { ...raw, title: String(raw.title).trim().slice(0, 1000), sourceKey: String(raw.sourceKey), sourceType: raw.sourceType || raw.type, externalIDs: externalIDs(raw.externalIDs), genres: Array.isArray(raw.genres) ? [...new Set(raw.genres.map(String))].slice(0, 100) : undefined };
  if (raw.year !== undefined) result.year = Number.isInteger(Number(raw.year)) && Number(raw.year) > 0 ? Number(raw.year) : null;
  if (raw.runtimeSeconds !== undefined) result.runtimeSeconds = Number(raw.runtimeSeconds) >= 0 ? Math.round(Number(raw.runtimeSeconds)) : null;
  if (raw.rating !== undefined) result.rating = Number.isFinite(Number(raw.rating)) ? Number(raw.rating) : null;
  return result;
}

/**
 * Source adapters produce normalized metadata only. Discovery must never call resolve().
 * catalog({key,cursor,limit,signal}) -> {items: MediaInput[], nextCursor: string|null}
 * metadata(mapping, context) -> MediaInput with optional children: MediaInput[]
 * Episodes may use seriesRef: {sourceType,sourceKey} for an earlier parent from
 * the same source. episodesInCatalog skips separate metadata-based episode indexing.
 * resolve(media, mapping|null, context) -> StreamCandidate[]
 * search, subtitles, epg and catchup are optional and governed by capabilities.
 * StreamCandidate carries sourceId, resource, protocol, quality, resolution, codec,
 * hdr, audio, languages, subtitles, requiredHeaders, expiresAt and resolver data.
 * Protocol wire IDs and transport credentials belong to source mappings/resources,
 * never to canonical IDs or metadata catalogue rows.
 */
function validateAdapter(adapter) {
  if (!adapter || typeof adapter.id !== "string" || !adapter.capabilities) throw new TypeError("Adapter requires an ID and capabilities");
  for (const [capability, method] of [["catalog", "catalog"], ["metadata", "metadata"], ["streams", "resolve"], ["search", "search"], ["subtitles", "subtitles"], ["epg", "epg"], ["catchup", "catchup"]]) {
    if (adapter.capabilities[capability] && typeof adapter[method] !== "function" && !(capability === "catalog" && typeof adapter.scanCatalog === "function")) throw new TypeError(`Adapter declares ${capability} without ${method}()`);
  }
  return adapter;
}
module.exports = { TYPES, CAPABILITIES, titleKey, capabilities, externalIDs, normalizeMedia, validateAdapter };

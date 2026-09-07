"use strict";
const crypto = require("node:crypto");
const { capabilities } = require("../core/model");
const { normalizeCandidate } = require("../core/resolver");
const { httpMedia } = require("../stream-policy");
const { cinematographicMetadata } = require("./cinemeta");

function contentId(media, series) {
  if (media.type === "episode") {
    const imdb = series?.externalIDs?.imdb;
    return imdb ? `${imdb}:${media.seasonNumber}:${media.episodeNumber}` : null;
  }
  return media.externalIDs?.imdb || null;
}
function canonicalType(type) { return type === "tv" || type === "channel" ? "channel" : type; }
function wireType(type) { return type === "episode" ? "series" : type === "channel" ? "tv" : type; }
function normalizeAddonConfig(config) {
  const { remoteManifestUrl, ...rest } = config;
  return { ...rest, addonUrl: config.addonUrl ?? remoteManifestUrl ?? "" };
}
function normalizeMetadata(raw, sourceType) {
  const type = canonicalType(raw.type || sourceType);
  const ids = raw.behaviorHints?.defaultVideoId || raw.id;
  const imdb = /^tt\d+$/.test(raw.id) ? raw.id : raw.imdb_id || raw.imdbId;
  const year = Number(String(raw.releaseInfo || raw.year || "").match(/\d{4}/)?.[0]) || undefined;
  const runtime = raw.runtime && String(raw.runtime).match(/^(\d+)\s*(min|minutes)?$/i);
  return { type, sourceType, sourceKey: String(raw.id), title: raw.name || raw.title || "Untitled", originalTitle: raw.originalTitle, year, description: raw.description, genres: raw.genres, runtimeSeconds: runtime ? Number(runtime[1]) * 60 : undefined, rating: raw.imdbRating == null ? undefined : Number(raw.imdbRating), certification: raw.certification, releaseDate: raw.released, externalIDs: { imdb, tmdb: raw.tmdb_id || raw.tmdbId || raw.moviedb_id, tvdb: raw.tvdb_id || raw.tvdbId }, artwork: Object.fromEntries([["poster", raw.poster], ["backdrop", raw.background], ["logo", raw.logo], ["thumbnail", raw.thumbnail]].filter(([, url]) => url && httpMedia(url))), resolverData: { contentId: String(ids) } };
}
async function createAddonSource(source, { caches } = {}) {
  const config = normalizeAddonConfig(source.configuration);
  const manifestUrl = config.addonUrl || (config.baseUrl.endsWith("/manifest.json") ? config.baseUrl : `${config.baseUrl}/manifest.json`);
  const root = new URL("./", manifestUrl);
  let nextMetadataRequest = 0;
  async function fetchJson(url, signal, ttl = 0) {
    const key = `${source.id}:${source.revision}:${url}`;
    const hit = ttl ? caches?.sourceResponses.get(key) : null;
    if (hit) return hit;
    const deadline = AbortSignal.timeout(15000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    if (source.protocol === "catalogue" && root.origin === "https://v3-cinemeta.strem.io") {
      const now = Date.now(), scheduled = Math.max(now, nextMetadataRequest);
      nextMetadataRequest = scheduled + 1000;
      if (scheduled > now) await require("node:timers/promises").setTimeout(scheduled - now, undefined, { signal: requestSignal });
    }
    let target = String(url), response;
    for (let redirect = 0; redirect <= 3; redirect++) {
      response = await fetch(target, { redirect: "manual", signal: requestSignal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirect === 3) throw new Error("Invalid source redirect");
      const next = new URL(location, target);
      const publicMetadataRedirect = source.protocol === "catalogue" && root.origin === "https://v3-cinemeta.strem.io" && next.origin === "https://cinemeta-catalogs.strem.io";
      if (!httpMedia(next.href) || next.origin !== new URL(target).origin && !publicMetadataRedirect) throw new Error("Source redirect is outside the configured origin");
      target = next.href;
    }
    if (!response.ok) {
      const retryAfter = response.status === 429 ? require("../core/playback-backoff").retrySeconds(response.headers.get("retry-after")) : undefined;
      await response.body?.cancel();
      throw Object.assign(new Error(`Source HTTP ${response.status}`), { upstreamStatus: response.status, ...(retryAfter == null ? {} : { retryAfter }) });
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error("Source response exceeds 8 MB"); chunks.push(chunk); }
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (ttl) caches?.sourceResponses.set(key, data, ttl);
    return data;
  }
  const manifest = await fetchJson(manifestUrl, undefined, 60000);
  if (!manifest.id || !Array.isArray(manifest.resources) || !Array.isArray(manifest.catalogs)) throw new Error("Invalid addon manifest");
  const resources = new Set(manifest.resources.map((resource) => typeof resource === "string" ? resource : resource.name));
  const types = [...new Set((manifest.types || []).map(canonicalType))];
  if (types.includes("series")) types.push("episode");
  const declaration = capabilities({ catalog: manifest.catalogs.length > 0, metadata: resources.has("meta"), search: manifest.catalogs.some((catalog) => catalog.extra?.some((extra) => extra.name === "search")), streams: resources.has("stream"), subtitles: resources.has("subtitles"), live: types.includes("channel"), types, identityNamespaces: resources.has("stream") && (manifest.idPrefixes || []).some((prefix) => "tt".startsWith(prefix) || prefix.startsWith("tt")) ? ["imdb"] : [] });
  // Unrestricted movie/series stream resources conventionally accept IMDb identities.
  if (resources.has("stream") && !manifest.idPrefixes && (types.includes("movie") || types.includes("series"))) declaration.identityNamespaces.push("imdb");
  const catalogs = [];
  const metadataOnly = source.protocol === "catalogue";
  const variantLimit = metadataOnly ? 256 : 64;
  let omittedCatalogs = 0;
  for (const [index, catalog] of manifest.catalogs.entries()) {
    const extra = catalog.extra || [];
    const required = extra.filter((item) => item.isRequired && !["search", "skip"].includes(item.name));
    // Personalized feeds need user state; they must not block public metadata feeds.
    if (metadataOnly && required.some(filter => !Array.isArray(filter.options) || !filter.options.length)) { omittedCatalogs++; continue; }
    let variants = [{}];
    for (const filter of required) {
      if (!Array.isArray(filter.options) || !filter.options.length || filter.options.length > variantLimit || typeof filter.name !== "string" || filter.name.length > 100) throw new Error(`Required catalogue filter needs 1 to ${variantLimit} preset options`);
      const options = [...new Set(filter.options)];
      if (options.some((value) => typeof value !== "string" || !value || value.length > 200) || variants.length * options.length > variantLimit) throw new Error("Catalogue filter variants exceed supported bounds");
      variants = variants.flatMap((variant) => options.map((value) => ({ ...variant, [filter.name]: value })));
    }
    for (const fixedExtras of variants) {
      if (catalogs.length >= 256) throw new Error("Source exceeds 256 catalogue variants");
      const suffix = Object.keys(fixedExtras).length ? `:${JSON.stringify(Object.entries(fixedExtras).sort(([a], [b]) => a.localeCompare(b)))}` : "";
      catalogs.push({ key: `${index}:${catalog.type}:${catalog.id}${suffix}`, type: canonicalType(catalog.type), title: catalog.name || catalog.id, searchable: extra.some((item) => item.name === "search"), enumerable: !extra.some((item) => item.isRequired && item.name === "search"), wire: catalog, fixedExtras });
    }
  }
  if (metadataOnly && !catalogs.length) throw new Error("Source has no supported metadata catalogues");
  if (metadataOnly) catalogs.sort((a, b) => {
    const year = catalog => /^\d{4}$/.test(catalog.fixedExtras.genre || "") ? Number(catalog.fixedExtras.genre) : 0;
    return year(b) - year(a);
  });
  const supportedDeclaration = capabilities({ ...declaration, catalog: catalogs.length > 0, search: catalogs.some(catalog => catalog.searchable) });
  const endpoint = (resource, type, id, extra = {}) => {
    const encoded = new URLSearchParams(extra).toString();
    return new URL(`${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}${encoded ? `/${encoded}` : ""}.json`, root).toString();
  };
  async function catalogue({ key, cursor, limit, signal, query }) {
    const catalog = catalogs.find((catalog) => catalog.key === key);
    if (!catalog || (!catalog.enumerable && !query)) throw new Error("Catalogue requires a search query");
    const state = cursor ? JSON.parse(cursor) : { offset: 0 };
    const extras = { ...catalog.fixedExtras, ...(state.offset || catalog.wire.extra?.some((extra) => extra.name === "skip" && extra.isRequired) ? { skip: String(state.offset) } : {}), ...(query ? { search: query } : {}) };
    const result = await fetchJson(endpoint("catalog", catalog.wire.type, catalog.wire.id, extras), signal, 30000);
    const metas = Array.isArray(result.metas) ? result.metas : [];
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(metas.map((meta) => meta.id))).digest("hex");
    if (state.fingerprint === fingerprint && !state.inPage) return { items: [], nextCursor: null };
    const start = state.inPage || 0;
    const selected = metas.slice(start, start + limit);
    const paginated = catalog.wire.extra?.some((extra) => extra.name === "skip");
    let nextCursor = null;
    if (start + selected.length < metas.length) nextCursor = JSON.stringify({ offset: state.offset, inPage: start + selected.length, fingerprint });
    else if (paginated && metas.length) nextCursor = JSON.stringify({ offset: state.offset + metas.length, fingerprint });
    return { items: selected.filter((meta) => meta?.id && meta?.name).map((meta) => {
      const media = normalizeMetadata(meta, catalog.wire.type);
      const genre = catalog.fixedExtras.genre;
      if (genre) {
        const yearFilter = /^\d{4}$/.test(genre);
        if (!yearFilter) media.genres = media.genres?.length ? media.genres : [genre];
        media.categories = [{ key: `${yearFilter ? "year" : "genre"}:${genre}`, name: yearFilter ? `Released ${genre}` : genre, kind: media.type }];
      }
      media.categories ||= [];
      media.categories.push({ key: JSON.stringify(["feed", catalog.wire.type, catalog.wire.id]), name: catalog.title, kind: media.type });
      for (const value of Array.isArray(media.genres) ? media.genres.slice(0, 100) : []) {
        if (typeof value !== "string" || !value.trim()) continue;
        const name = value.trim();
        if (!media.categories.some(category => category.key === `genre:${name}`)) media.categories.push({ key: `genre:${name}`, name, kind: media.type });
      }
      return media;
    }), nextCursor };
  }
  return {
    id: source.id, capabilities: supportedDeclaration, catalogs, omittedCatalogs, resolutionTtlMs: Number(config.streamCacheTtlMs ?? 30000),
    catalog: catalogue,
    search: (context) => catalogue({ ...context, query: context.query }),
    async metadata(mapping, context = {}) {
      // Episode details come from the series video list; episode IDs are stream identities.
      if (context.media?.type === "episode") return { ...context.media, sourceKey: mapping.sourceKey, sourceType: mapping.sourceType, resolverData: mapping.resolverData || {} };
      let response;
      try { response = await fetchJson(endpoint("meta", mapping.sourceType, mapping.sourceKey), context.signal, 60000); }
      catch (error) { if (context.signal?.aborted) throw error; response = {}; }
      if (!response.meta || context.media?.type === "series" && !response.meta.videos?.length) {
        const existing = response.meta ? normalizeMetadata(response.meta, mapping.sourceType) : {};
        const media = { ...context.media, ...existing, externalIDs: { ...context.media?.externalIDs, ...Object.fromEntries(Object.entries(existing.externalIDs || {}).filter(([, value]) => value)) } };
        try {
          const fallback = await cinematographicMetadata(media, { signal: context.signal, caches });
          if (fallback) response = { meta: { ...fallback, ...response.meta, imdb_id: fallback.id, videos: fallback.videos } };
        } catch (error) { if (context.signal?.aborted) throw error; }
      }
      if (!response.meta) return null;
      const metadata = normalizeMetadata(response.meta, mapping.sourceType);
      metadata.sourceKey = mapping.sourceKey;
      if (metadata.type === "series" && Array.isArray(response.meta.videos)) metadata.children = response.meta.videos.filter((video) => video.id && Number.isInteger(video.season) && Number.isInteger(video.episode)).map((video) => ({ type: "episode", sourceType: "series", sourceKey: String(video.id), title: video.title || video.name || `Episode ${video.episode}`, seriesId: context.media.id, seasonNumber: video.season, episodeNumber: video.episode, releaseDate: video.released, artwork: video.thumbnail ? { thumbnail: video.thumbnail } : {}, resolverData: { contentId: String(video.id) } }));
      return metadata;
    },
    async resolve(media, mapping, context) {
      const id = mapping?.resolverData?.contentId || mapping?.sourceKey || contentId(media, context.series);
      if (!id) return [];
      const result = await fetchJson(endpoint("stream", mapping?.sourceType || wireType(media.type), id), context.signal);
      return (result.streams || []).map((stream) => {
        if (["infoHash", "info_hash", "magnet", "torrent", "torrentUrl", "sources", "fileIdx"].some((key) => key in stream)) return null;
        return normalizeCandidate({ ...stream, requiredHeaders: stream.behaviorHints?.proxyHeaders?.request || {}, resource: { url: stream.url } }, source.id);
      }).filter(Boolean);
    },
    async subtitles(media, mapping, context) {
      const id = mapping?.sourceKey || contentId(media, context.series);
      if (!id || !declaration.subtitles) return [];
      const result = await fetchJson(endpoint("subtitles", mapping?.sourceType || wireType(media.type), id), context.signal, 30000);
      return (result.subtitles || []).filter((subtitle) => httpMedia(subtitle.url)).map((subtitle) => ({ id: subtitle.id, language: subtitle.lang, url: subtitle.url, sourceId: source.id }));
    }
  };
}
module.exports = { createAddonSource, contentId, normalizeMetadata, normalizeAddonConfig };

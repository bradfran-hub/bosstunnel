"use strict";
const { capabilities } = require("../core/model");
const { json } = require("./transport");
const { httpMedia } = require("../stream-policy");
async function createPlexSource(source) {
  const config = source.configuration;
  const root = new URL(`${config.baseUrl.replace(/\/$/, "")}/`);
  const headers = { Accept: "application/json", "X-Plex-Token": config.apiKey, "X-Plex-Client-Identifier": `boss-${source.id}`, "X-Plex-Product": "Boss Media Servers", "X-Plex-Version": "1.0.0" };
  function location(key) {
    const url = new URL(key.startsWith("/library/") ? `.${key}` : key, root);
    if (!httpMedia(url.href) || url.origin !== root.origin || !url.pathname.startsWith(`${root.pathname}library/`)) throw new Error("Plex resource is outside the configured server");
    return url.href;
  }
  async function container(key, params = {}, signal, page) {
    const url = new URL(location(key));
    for (const [name, value] of Object.entries(params)) if (value != null) url.searchParams.set(name, String(value));
    const result = await json(url.href, { headers: { ...headers, ...(page ? { "X-Plex-Container-Start": String(page.offset), "X-Plex-Container-Size": String(page.limit) } : {}) }, signal: signal || AbortSignal.timeout(15000) });
    if (!result.MediaContainer || typeof result.MediaContainer !== "object") throw new Error("Invalid Plex response");
    return result.MediaContainer;
  }
  const sections = (await container("/library/sections")).Directory || [];
  const catalogs = sections.filter((section) => ["movie", "show"].includes(section.type) && (!config.libraryPath || String(section.key) === config.libraryPath)).map((section) => ({ key: String(section.key), type: section.type === "show" ? "series" : "movie", title: section.title, enumerable: true, searchable: true }));
  if (config.libraryPath && !catalogs.length) throw new Error("Plex library is unavailable or unsupported");
  const declaration = capabilities({ catalog: true, metadata: true, search: true, streams: true, subtitles: true, types: ["movie", "series", "episode"] });
  function normalize(raw, seriesId) {
    const type = { movie: "movie", show: "series", season: "season", episode: "episode" }[raw.type];
    if (!type || !raw.ratingKey) return null;
    const externalIDs = {};
    for (const guid of [...(raw.Guid || []), ...(raw.guid ? [{ id: raw.guid }] : [])]) {
      const match = /^(imdb|tmdb|tvdb):\/\/([^/?#]+)$/.exec(guid.id || "");
      if (match) externalIDs[match[1]] = match[2];
    }
    const artwork = {};
    for (const [kind, key] of [["poster", raw.thumb], ["backdrop", raw.art]]) if (key) {
      try { artwork[kind] = { url: location(key), headers }; } catch {}
    }
    return { type, sourceType: raw.type, sourceKey: String(raw.ratingKey), title: raw.title || "Untitled", originalTitle: raw.originalTitle, year: raw.year, description: raw.summary, genres: (raw.Genre || []).map((genre) => genre.tag), runtimeSeconds: raw.duration ? Math.round(raw.duration / 1000) : undefined, rating: raw.rating, certification: raw.contentRating, releaseDate: raw.originallyAvailableAt, externalIDs, artwork, ...(type === "episode" ? { seriesId, seasonNumber: Number(raw.parentIndex || 0), episodeNumber: Number(raw.index || 0) } : {}), resolverData: { ratingKey: String(raw.ratingKey) } };
  }
  async function catalog({ key, cursor, limit, query, signal }) {
    const child = key.startsWith("{") ? JSON.parse(key) : null;
    const definition = child || catalogs.find((catalog) => catalog.key === key);
    if (!definition) throw new Error("Unknown Plex catalogue");
    const offset = Number(cursor || 0);
    const page = await container(child ? `/library/metadata/${encodeURIComponent(child.parent)}/allLeaves` : `/library/sections/${encodeURIComponent(key)}/all`, { ...(child ? {} : { type: definition.type === "movie" ? 1 : 2 }), ...(query ? { title: query } : {}) }, signal, { offset, limit });
    const rows = page.Metadata || [];
    if (!Array.isArray(rows) || rows.length > limit || (page.offset != null && Number(page.offset) !== offset)) throw new Error("Plex did not honor catalogue pagination");
    return { items: rows.map((raw) => normalize(raw, child?.seriesId)).filter(Boolean), nextCursor: rows.length && (page.totalSize == null ? rows.length === limit : offset + rows.length < Number(page.totalSize)) ? String(offset + rows.length) : null };
  }
  async function metadataItem(mapping, signal) {
    if (!mapping) return null;
    return (await container(`/library/metadata/${encodeURIComponent(mapping.sourceKey)}`, {}, signal)).Metadata?.[0] || null;
  }
  return {
    id: source.id, capabilities: declaration, catalogs, catalog, search: catalog, resolutionTtlMs: 30000,
    async metadata(mapping, context) {
      const raw = await metadataItem(mapping, context.signal);
      if (!raw) return null;
      const result = normalize(raw, context.media.seriesId);
      if (result?.type === "series") result.childCatalogs = [{ key: JSON.stringify({ parent: String(raw.ratingKey), seriesId: context.media.id }), type: "episode", title: raw.title, enumerable: true }];
      return result;
    },
    async resolve(media, mapping, context) {
      const raw = await metadataItem(mapping, context.signal);
      if (!raw || !["movie", "episode"].includes(media.type)) return [];
      return (raw.Media || []).flatMap((variant) => {
        if (variant.Part?.length !== 1 || !variant.Part[0].key || variant.Part[0].exists === false || variant.Part[0].accessible === false) return [];
        const part = variant.Part[0];
        let url;
        try { url = location(part.key); } catch { return []; }
        if (!new URL(url).pathname.startsWith(`${root.pathname}library/parts/`)) return [];
        const tracks = part.Stream || [];
        const video = tracks.find((stream) => Number(stream.streamType) === 1);
        const audio = tracks.filter((stream) => Number(stream.streamType) === 2).map((stream) => ({ codec: stream.codec, language: stream.languageCode, channels: stream.channels }));
        return [{ resource: { url }, protocol: "http", container: part.container || variant.container, codec: video?.codec || variant.videoCodec, resolution: { width: video?.width || variant.width, height: video?.height || variant.height }, hdr: video?.DOVIPresent ? "Dolby Vision" : video?.colorTrc === "smpte2084" ? "HDR10" : null, audio, languages: audio.map((stream) => stream.language).filter(Boolean), requiredHeaders: headers }];
      });
    },
    async subtitles(media, mapping, context) {
      const raw = await metadataItem(mapping, context.signal);
      return (raw?.Media || []).flatMap((variant) => (variant.Part || []).flatMap((part) => (part.Stream || []).flatMap((stream) => {
        if (Number(stream.streamType) !== 3 || !stream.key || !["srt", "ass", "ssa", "vtt", "webvtt"].includes(stream.codec)) return [];
        try { return [{ id: String(stream.id), language: stream.languageCode || "und", resource: { url: location(stream.key), headers } }]; } catch { return []; }
      })));
    }
  };
}
module.exports = { createPlexSource };

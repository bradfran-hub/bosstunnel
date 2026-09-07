"use strict";
const axios = require("axios");
const { capabilities } = require("../core/model");

function normalizeMetadata(raw, source, headers, seriesId) {
  const type = { Movie: "movie", Series: "series", Episode: "episode", Season: "season" }[raw.Type];
  if (!type) return null;
  const resource = (kind) => ({ url: `${source.configuration.baseUrl}/Items/${encodeURIComponent(raw.Id)}/Images/${kind}`, headers });
  return { type, sourceType: raw.Type, sourceKey: String(raw.Id), title: raw.Name || "Untitled", originalTitle: raw.OriginalTitle, year: raw.ProductionYear, description: raw.Overview, genres: raw.Genres, runtimeSeconds: raw.RunTimeTicks ? Math.round(raw.RunTimeTicks / 10000000) : undefined, rating: raw.CommunityRating, certification: raw.OfficialRating, releaseDate: raw.PremiereDate, externalIDs: { imdb: raw.ProviderIds?.Imdb, tmdb: raw.ProviderIds?.Tmdb, tvdb: raw.ProviderIds?.Tvdb }, artwork: { ...(raw.ImageTags?.Primary ? { poster: resource("Primary") } : {}), ...(raw.BackdropImageTags?.length ? { backdrop: resource("Backdrop") } : {}), ...(raw.ImageTags?.Logo ? { logo: resource("Logo") } : {}), ...(raw.ImageTags?.Thumb ? { thumbnail: resource("Thumb") } : {}) }, ...(type === "episode" ? { seriesId, seasonNumber: raw.ParentIndexNumber || 0, episodeNumber: raw.IndexNumber || 0 } : {}), resolverData: { itemId: String(raw.Id) } };
}
async function createMediaServerSource(source) {
  const config = source.configuration;
  let headers;
  let itemsApi;
  if (source.protocol === "jellyfin") {
    const { Jellyfin } = await import("@jellyfin/sdk");
    const { getItemsApi } = await import("@jellyfin/sdk/lib/utils/api/items-api.js");
    const sdk = new Jellyfin({ clientInfo: { name: "Boss Media Servers", version: "1.0.0" }, deviceInfo: { name: "Boss Server", id: "boss-media" } });
    const api = sdk.createApi(config.baseUrl, config.apiKey, axios.create({ timeout: 15000, maxRedirects: 0, maxContentLength: 8 * 1024 * 1024 }));
    itemsApi = getItemsApi(api); headers = { Authorization: api.authorizationHeader };
  } else headers = { "X-Emby-Token": config.apiKey, "X-Emby-Authorization": 'MediaBrowser Client="Boss Media Servers", Device="Server", DeviceId="boss-media", Version="1.0.0"' };
  async function items(params, signal) {
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    const query = { recursive: true, parentId: config.libraryPath || undefined, userId: config.userId || undefined, fields: ["Overview", "Genres", "ProviderIds", "MediaSources", "MediaStreams"], ...params };
    if (itemsApi) return (await itemsApi.getItems(query, { signal })).data;
    const url = new URL(`${config.baseUrl}/Items`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key[0].toUpperCase() + key.slice(1), Array.isArray(value) ? value.join(",") : String(value));
    const response = await fetch(url, { headers, signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`Media server returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error("Source response exceeds 8 MB"); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  const declaration = capabilities({ catalog: true, metadata: true, search: true, streams: true, subtitles: true, types: ["movie", "series", "episode"] });
  const catalogs = [{ key: "movies", type: "movie", title: "Movies", enumerable: true, searchable: true }, { key: "series", type: "series", title: "Series", enumerable: true, searchable: true }];
  async function catalog({ key, cursor, limit, signal, query }) {
    const descriptor = key.startsWith("{") ? JSON.parse(key) : { type: key === "movies" ? "Movie" : "Series" };
    const offset = Number(cursor || 0);
    const result = await items({ includeItemTypes: [descriptor.type], startIndex: offset, limit, ...(descriptor.parent ? { parentId: descriptor.parent } : {}), ...(query ? { searchTerm: query } : {}) }, signal);
    const rows = result.Items || [];
    const total = result.TotalRecordCount;
    return { items: rows.map((raw) => normalizeMetadata(raw, source, headers, descriptor.seriesId)).filter(Boolean), nextCursor: rows.length && (total == null ? rows.length === limit : offset + rows.length < total) ? String(offset + rows.length) : null };
  }
  return {
    id: source.id, capabilities: declaration, catalogs, catalog, resolutionTtlMs: 30000,
    search: (context) => catalog(context),
    async metadata(mapping, context) {
      const raw = (await items({ ids: [mapping.sourceKey], limit: 1 }, context.signal)).Items?.[0];
      if (!raw) return null;
      const result = normalizeMetadata(raw, source, headers, context.media.seriesId);
      if (raw.Type === "Series") result.childCatalogs = [{ key: JSON.stringify({ type: "Episode", parent: raw.Id, seriesId: context.media.id }), type: "episode", title: raw.Name, enumerable: true }];
      return result;
    },
    async resolve(media, mapping, context) {
      if (!mapping || !["movie", "episode"].includes(media.type)) return [];
      const raw = (await items({ ids: [mapping.sourceKey], limit: 1 }, context.signal)).Items?.[0];
      if (!raw) return [];
      return (raw.MediaSources?.length ? raw.MediaSources : [{ Id: raw.Id, MediaStreams: raw.MediaStreams || [] }]).map((variant) => {
        const video = variant.MediaStreams?.find((stream) => stream.Type === "Video");
        const url = new URL(`${config.baseUrl}/Videos/${encodeURIComponent(raw.Id)}/stream`);
        url.searchParams.set("static", "true"); if (variant.Id) url.searchParams.set("mediaSourceId", variant.Id);
        return { resource: { url: url.toString() }, protocol: "http", requiredHeaders: headers, container: variant.Container, codec: video?.Codec, resolution: video ? { width: video.Width, height: video.Height } : null, hdr: video?.VideoRangeType && video.VideoRangeType !== "SDR" ? video.VideoRangeType : null, audio: (variant.MediaStreams || []).filter((stream) => stream.Type === "Audio").map((stream) => ({ codec: stream.Codec, language: stream.Language, channels: stream.Channels })), languages: (variant.MediaStreams || []).filter((stream) => stream.Type === "Audio" && stream.Language).map((stream) => stream.Language) };
      });
    },
    async subtitles(media, mapping, context) {
      if (!mapping) return [];
      const raw = (await items({ ids: [mapping.sourceKey], limit: 1 }, context.signal)).Items?.[0];
      if (!raw) return [];
      return (raw.MediaSources || []).flatMap((variant) => (variant.MediaStreams || []).filter((stream) => stream.Type === "Subtitle" && stream.IsExternal && ["srt", "subrip", "vtt", "webvtt", "ass", "ssa"].includes(stream.Codec)).map((stream) => ({ id: `${variant.Id}:${stream.Index}`, language: stream.Language || "und", sourceId: source.id, resource: { url: `${config.baseUrl}/Videos/${encodeURIComponent(raw.Id)}/${encodeURIComponent(variant.Id)}/Subtitles/${stream.Index}/Stream.${["vtt", "webvtt"].includes(stream.Codec) ? "vtt" : "srt"}`, headers } })));
    }
  };
}
module.exports = { createMediaServerSource, normalizeMetadata };

"use strict";
const axios = require("axios");
const { networkFetch: fetch, axiosOptions, requestSignal } = require("../core/network");
const { capabilities } = require("../core/model");
const { httpMedia } = require("../stream-policy");

function normalizeMetadata(raw, source, headers, seriesId) {
  const type = { Movie: "movie", Series: "series", Episode: "episode", Season: "season", TvChannel: "channel" }[raw.Type];
  if (!type) return null;
  const resource = (kind) => ({ url: `${source.configuration.baseUrl}/Items/${encodeURIComponent(raw.Id)}/Images/${kind}`, headers });
  return { type, sourceType: raw.Type, sourceKey: String(raw.Id), title: raw.Name || "Untitled", originalTitle: raw.OriginalTitle, year: raw.ProductionYear, description: raw.Overview, genres: raw.Genres, runtimeSeconds: raw.RunTimeTicks ? Math.round(raw.RunTimeTicks / 10000000) : undefined, rating: raw.CommunityRating, certification: raw.OfficialRating, releaseDate: raw.PremiereDate, externalIDs: { imdb: raw.ProviderIds?.Imdb, tmdb: raw.ProviderIds?.Tmdb, tvdb: raw.ProviderIds?.Tvdb }, artwork: { ...(raw.ImageTags?.Primary ? { poster: resource("Primary") } : {}), ...(raw.BackdropImageTags?.length ? { backdrop: resource("Backdrop") } : {}), ...(raw.ImageTags?.Logo ? { logo: resource("Logo") } : {}), ...(raw.ImageTags?.Thumb ? { thumbnail: resource("Thumb") } : {}) }, ...(type === "episode" ? { seriesId, seasonNumber: raw.ParentIndexNumber || 0, episodeNumber: raw.IndexNumber || 0 } : {}), ...(type === "channel" ? { channel: { number: raw.ChannelNumber ?? raw.Number, epgId: String(raw.Id) } } : {}), resolverData: { itemId: String(raw.Id) } };
}
function mediaVariant(variant, url, headers) {
  const video = variant.MediaStreams?.find(stream => stream.Type === "Video");
  return { resource: { url }, requiredHeaders: headers, container: variant.Container, codec: video?.Codec, bitrate: variant.Bitrate,
    video: video ? { bitrate: video.BitRate, bitDepth: video.BitDepth, level: video.Level, frameRate: video.AverageFrameRate || video.RealFrameRate, profile: video.Profile } : {},
    resolution: video ? { width: video.Width, height: video.Height } : null, hdr: video?.VideoRangeType && video.VideoRangeType !== "SDR" ? video.VideoRangeType : null,
    audio: (variant.MediaStreams || []).filter(stream => stream.Type === "Audio").map(stream => ({ codec: stream.Codec, language: stream.Language, channels: stream.Channels, index: stream.Index, bitrate: stream.BitRate, sampleRate: stream.SampleRate })),
    languages: (variant.MediaStreams || []).filter(stream => stream.Type === "Audio" && stream.Language).map(stream => stream.Language) };
}
async function createMediaServerSource(source) {
  const config = source.configuration;
  let headers;
  let itemsApi;
  let liveApi, mediaApi;
  if (source.protocol === "jellyfin") {
    const { Jellyfin } = await import("@jellyfin/sdk");
    const { getItemsApi } = await import("@jellyfin/sdk/lib/utils/api/items-api.js");
    const { getLiveTvApi } = await import("@jellyfin/sdk/lib/utils/api/live-tv-api.js");
    const { getMediaInfoApi } = await import("@jellyfin/sdk/lib/utils/api/media-info-api.js");
    const sdk = new Jellyfin({ clientInfo: { name: "Boss Media Servers", version: "1.0.0" }, deviceInfo: { name: "Boss Server", id: "boss-media" } });
    const api = sdk.createApi(config.baseUrl, config.apiKey, axios.create({ timeout: 15000, maxRedirects: 0, maxContentLength: 8 * 1024 * 1024, ...axiosOptions() }));
    itemsApi = getItemsApi(api); headers = { Authorization: api.authorizationHeader };
    liveApi = getLiveTvApi(api); mediaApi = getMediaInfoApi(api);
  } else headers = { "X-Emby-Token": config.apiKey, "X-Emby-Authorization": 'MediaBrowser Client="Boss Media Servers", Device="Server", DeviceId="boss-media", Version="1.0.0"' };
  const deadline = signal => requestSignal(signal, AbortSignal.timeout(15000));
  async function rest(path, params = {}, signal, input) {
    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key[0].toUpperCase() + key.slice(1), Array.isArray(value) ? value.join(",") : String(value));
    const response = await fetch(url, { headers: { ...headers, ...(input ? { "Content-Type": "application/json" } : {}) }, signal: deadline(signal), redirect: "error", ...(input ? { method: "POST", body: JSON.stringify(input) } : {}) });
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
  async function items(params, signal) {
    const query = { recursive: true, parentId: config.libraryPath || undefined, userId: config.userId || undefined, fields: ["Overview", "Genres", "ProviderIds", "MediaSources", "MediaStreams"], ...params };
    return itemsApi ? (await itemsApi.getItems(query, { signal: deadline(signal) })).data : rest("/Items", query, signal);
  }
  const live = async (method, path, params, signal) => liveApi ? (await liveApi[method](params, { signal: deadline(signal) })).data : rest(path, params, signal);
  let hasLive = false, hasEpg = false;
  if (config.userId && !config.libraryPath) {
    try {
      const info = liveApi ? (await liveApi.getLiveTvInfo({ signal: deadline() })).data : await rest("/LiveTv/Info");
      const userKey = id => String(id).replaceAll("-", "").toLowerCase();
      if (info.IsEnabled === true && Array.isArray(info.EnabledUsers) && info.EnabledUsers.some(id => userKey(id) === userKey(config.userId))) {
        await live("getLiveTvChannels", "/LiveTv/Channels", { userId: config.userId, limit: 1 });
        hasLive = true;
        await live("getLiveTvPrograms", "/LiveTv/Programs", { userId: config.userId, limit: 1 });
        hasEpg = true;
      }
    } catch (error) { if (![401, 403, 404].includes(error.status || error.response?.status)) throw error; }
  }
  const declaration = capabilities({ catalog: true, metadata: true, search: true, streams: true, subtitles: true, live: hasLive, epg: hasEpg, types: ["movie", "series", "episode", ...(hasLive ? ["channel"] : [])] });
  const catalogs = [{ key: "movies", type: "movie", title: "Movies", enumerable: true, searchable: true }, { key: "series", type: "series", title: "Series", enumerable: true, searchable: true }];
  if (hasLive) catalogs.push({ key: "channels", type: "channel", title: "Live TV", enumerable: true, searchable: false });
  async function catalog({ key, cursor, limit, signal, query }) {
    if (key === "channels") {
      if (!hasLive) throw new Error("Live catalogue is unavailable");
      const offset = Number(cursor || 0), result = await live("getLiveTvChannels", "/LiveTv/Channels", { userId: config.userId, startIndex: offset, limit, fields: ["Overview", "Genres"] }, signal);
      const rows = result.Items || [];
      return { items: rows.map(raw => normalizeMetadata({ ...raw, Type: "TvChannel" }, source, headers)).filter(Boolean), nextCursor: rows.length && (result.TotalRecordCount == null ? rows.length === limit : offset + rows.length < result.TotalRecordCount) ? String(offset + rows.length) : null };
    }
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
      if (context.media.type === "channel") {
        if (!hasLive) return null;
        const raw = liveApi ? (await liveApi.getChannel({ channelId: mapping.sourceKey, userId: config.userId }, { signal: deadline(context.signal) })).data : await rest(`/LiveTv/Channels/${encodeURIComponent(mapping.sourceKey)}`, { userId: config.userId }, context.signal);
        return normalizeMetadata({ ...raw, Type: "TvChannel" }, source, headers);
      }
      const raw = (await items({ ids: [mapping.sourceKey], limit: 1 }, context.signal)).Items?.[0];
      if (!raw) return null;
      const result = normalizeMetadata(raw, source, headers, context.media.seriesId);
      if (raw.Type === "Series") result.childCatalogs = [{ key: JSON.stringify({ type: "Episode", parent: raw.Id, seriesId: context.media.id }), type: "episode", title: raw.Name, enumerable: true }];
      return result;
    },
    async resolve(media, mapping, context) {
      if (mapping && media.type === "channel" && hasLive) {
        const input = { UserId: config.userId, AutoOpenLiveStream: false, EnableDirectPlay: true, EnableDirectStream: false, EnableTranscoding: false };
        const data = mediaApi ? (await mediaApi.getPostedPlaybackInfo({ itemId: mapping.sourceKey, playbackInfoDto: input }, { signal: deadline(context.signal) })).data : await rest(`/Items/${encodeURIComponent(mapping.sourceKey)}/PlaybackInfo`, { userId: config.userId }, context.signal, input);
        return (data.MediaSources || []).filter(variant => variant.SupportsDirectPlay === true && !variant.RequiresOpening && !variant.RequiresClosing && !variant.LiveStreamId && httpMedia(variant.Path)).map(variant => {
          const sameOrigin = new URL(variant.Path).origin === new URL(config.baseUrl).origin;
          return mediaVariant(variant, variant.Path, { ...(sameOrigin ? headers : {}), ...(variant.RequiredHttpHeaders || {}) });
        });
      }
      if (!mapping || !["movie", "episode"].includes(media.type)) return [];
      const raw = (await items({ ids: [mapping.sourceKey], limit: 1 }, context.signal)).Items?.[0];
      if (!raw) return [];
      return (raw.MediaSources?.length ? raw.MediaSources : [{ Id: raw.Id, MediaStreams: raw.MediaStreams || [] }]).map((variant) => {
        const url = new URL(`${config.baseUrl}/Videos/${encodeURIComponent(raw.Id)}/stream`);
        url.searchParams.set("static", "true"); if (variant.Id) url.searchParams.set("mediaSourceId", variant.Id);
        return { ...mediaVariant(variant, url.toString(), headers), protocol: "http" };
      });
    },
    async *epg({ signal }) {
      if (!hasEpg) return;
      let offset = 0;
      const minEndDate = new Date().toISOString(), maxStartDate = new Date(Date.now() + 7 * 86400000).toISOString();
      while (true) {
        signal?.throwIfAborted();
        const result = await live("getLiveTvPrograms", "/LiveTv/Programs", { userId: config.userId, minEndDate, maxStartDate, startIndex: offset, limit: 200 }, signal);
        const rows = result.Items || [];
        if (rows.length > 200) throw new Error("Media server exceeded guide page limit");
        for (const raw of rows) {
          const startsAt = Date.parse(raw.StartDate), endsAt = Date.parse(raw.EndDate);
          if (!raw.Id || !raw.ChannelId || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) continue;
          yield { sourceKey: String(raw.Id), channelKey: String(raw.ChannelId), title: raw.Name || "Untitled", description: raw.Overview || "", startsAt, endsAt };
        }
        offset += rows.length;
        if (!rows.length || (result.TotalRecordCount == null ? rows.length < 200 : offset >= result.TotalRecordCount)) return;
        if (offset >= 1000000) throw new Error("Media server guide exceeded bounded scan size");
      }
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

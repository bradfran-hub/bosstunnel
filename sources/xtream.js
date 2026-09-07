"use strict";
const { capabilities } = require("../core/model");
const { json, jsonValues, pages, request } = require("./transport");
const { xmltv, probeXmltv } = require("./xmltv");

async function createXtreamSource(source) {
  const config = source.configuration;
  const endpoint = (action, params = {}) => { const url = new URL(`${config.baseUrl}/player_api.php`); url.search = new URLSearchParams({ username: config.username, password: config.password, ...(action ? { action } : {}), ...params }); return url.toString(); };
  const auth = await json(endpoint());
  if (Number(auth.user_info?.auth) !== 1 || auth.user_info.status && auth.user_info.status !== "Active") throw new Error("Xtream authentication failed");
  const automaticGuide = new URL(`${config.baseUrl.replace(/\/$/, "")}/xmltv.php`);
  automaticGuide.search = new URLSearchParams({ username: config.username, password: config.password });
  const guideUrl = config.xmltvUrl || (await probeXmltv(automaticGuide.href) ? automaticGuide.href : null);
  const archiveClock = new Intl.DateTimeFormat("en-GB", { timeZone: config.archiveTimezone || auth.server_info?.timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const caps = capabilities({ catalog: true, metadata: true, streams: true, live: true, epg: Boolean(guideUrl), catchup: Boolean(config.enableCatchup), types: ["movie", "series", "episode", "channel"] });
  const catalogs = [{ key: "movies", type: "movie", title: "Movies", enumerable: true }, { key: "series", type: "series", title: "Series", enumerable: true }, { key: "channels", type: "channel", title: "Live TV", enumerable: true }];
  const meta = (raw, type, extra = {}) => ({ type, sourceKey: String(raw.series_id ?? raw.stream_id ?? raw.id), title: raw.name || raw.title || "Untitled", description: raw.plot || raw.info?.plot, year: Number(String(raw.releaseDate || raw.release_date || "").slice(0, 4)) || undefined, genres: raw.genre ? raw.genre.split(/[,/]/).map((g) => g.trim()) : [], rating: Number(raw.rating) || undefined, externalIDs: { imdb: raw.imdb_id || raw.info?.imdb_id, tmdb: raw.tmdb_id || raw.tmdb || raw.info?.tmdb_id, tvdb: raw.tvdb_id }, artwork: raw.stream_icon || raw.cover ? { poster: raw.stream_icon || raw.cover, ...(type === "channel" ? { logo: raw.stream_icon } : {}) } : {}, channel: type === "channel" ? { number: raw.num == null ? null : String(raw.num), epgId: raw.epg_channel_id || null, catchupDays: config.enableCatchup && Number(raw.tv_archive) ? Number(raw.tv_archive_duration) || 0 : 0 } : undefined, categories: raw.category_id ? [{ key: String(raw.category_id), name: raw.category_name || String(raw.category_id), kind: type }] : [], resolverData: { id: String(raw.series_id ?? raw.stream_id ?? raw.id), extension: raw.container_extension || (type === "channel" ? "ts" : "mp4"), category: String(raw.category_id || ""), catchupDays: Number(raw.tv_archive) ? Number(raw.tv_archive_duration) || 0 : 0 }, ...extra });
  async function* records(key, signal) {
    if (key.startsWith("{")) {
      const descriptor = JSON.parse(key);
      for await (const raw of jsonValues(endpoint("get_series_info", { series_id: descriptor.parent }), { signal, paths: ["$.episodes.*.*"] })) yield meta(raw, "episode", { sourceKey: String(raw.id), seriesId: descriptor.seriesId, seasonNumber: Number(raw.season) || 0, episodeNumber: Number(raw.episode_num) || 0 });
      return;
    }
    const action = { movies: "get_vod_streams", series: "get_series", channels: "get_live_streams" }[key];
    if (!action) throw new Error("Unknown Xtream catalogue");
    const type = { movies: "movie", series: "series", channels: "channel" }[key];
    for await (const raw of jsonValues(endpoint(action), { signal })) if (raw && (raw.stream_id != null || raw.series_id != null)) yield meta(raw, type);
  }
  const target = (type, id, extension) => `${config.baseUrl}/${{ movie: "movie", episode: "series", channel: "live" }[type]}/${encodeURIComponent(config.username)}/${encodeURIComponent(config.password)}/${encodeURIComponent(id)}.${/^[a-z0-9]{1,5}$/i.test(extension) ? extension : "mp4"}`;
  return {
    id: source.id, capabilities: caps, catalogs, resolutionTtlMs: 15000,
    scanCatalog: (context) => pages(records(context.key, context.signal), context),
    async metadata(mapping, context) {
      if (context.media.type === "series") return { ...context.media, sourceKey: mapping.sourceKey, sourceType: mapping.sourceType, resolverData: mapping.resolverData, childCatalogs: [{ key: JSON.stringify({ parent: mapping.sourceKey, seriesId: context.media.id }), type: "episode", enumerable: true }] };
      if (context.media.type !== "movie") return { ...context.media, sourceKey: mapping.sourceKey, sourceType: mapping.sourceType, resolverData: mapping.resolverData };
      const data = await json(endpoint("get_vod_info", { vod_id: mapping.sourceKey }), { signal: context.signal });
      return { ...meta({ ...data.info, ...data.movie_data, stream_id: mapping.sourceKey, plot: data.info?.plot, cover: data.info?.movie_image }, "movie"), title: data.info?.name || data.movie_data?.name || context.media.title };
    },
    async resolve(media, mapping) {
      if (!mapping || !["movie", "episode", "channel"].includes(media.type)) return [];
      return [{ resource: { url: target(media.type, mapping.sourceKey, mapping.resolverData.extension) }, container: mapping.resolverData.extension, protocol: mapping.resolverData.extension === "m3u8" ? "hls" : "http" }];
    },
    async *epg({ signal }) { if (guideUrl) yield* xmltv((await request(guideUrl, { signal })).body); },
    async catchup(media, mapping, context) {
      if (!caps.catchup || !mapping?.resolverData.catchupDays || context.start < Date.now() - mapping.resolverData.catchupDays * 86400000) return [];
      const parts = Object.fromEntries(archiveClock.formatToParts(new Date(context.start)).map((part) => [part.type, part.value]));
      const start = `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
      const minutes = Math.max(1, Math.ceil((context.end - context.start) / 60000));
      return [{ resource: { url: `${config.baseUrl}/timeshift/${encodeURIComponent(config.username)}/${encodeURIComponent(config.password)}/${minutes}/${start}/${encodeURIComponent(mapping.sourceKey)}.ts` }, protocol: "http", container: "ts" }];
    }
  };
}
module.exports = { createXtreamSource };

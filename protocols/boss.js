"use strict";
const { categoryNumber, primaryCategory, categoryPage } = require("./categories");
const { capabilityDescriptor } = require("../core/player-capabilities");
function archiveContext(params) {
  const start = Number(params.get("start")), end = Number(params.get("end"));
  if (!params.has("start") || !params.has("end") || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > Date.now() + 60000 || end - start > 86400000) throw Object.assign(new Error("Invalid archive interval"), { status: 400 });
  return { start, end };
}
function createBossOutput(library, root) {
  const record = (media, category) => ({
    id: media.canonicalId, xtreamId: library.engine.synthetic("xtream", media.id), type: media.type, title: media.title, originalTitle: media.originalTitle,
    year: media.year, description: media.description, genres: media.genres, runtimeSeconds: media.runtimeSeconds,
    rating: media.rating, certification: media.certification, releaseDate: media.releaseDate,
    identities: media.externalIDs, artwork: library.artwork(media), artworkResources: library.artworkResources(media),
    ...(["movie", "series", "channel", "event"].includes(media.type) ? { category: primaryCategory(library, media, category) } : {}),
    ...(media.type === "channel" ? { channel: { number: media.channel?.number || null, epgId: String(library.engine.synthetic("xtream", media.id)), catchupDays: library.archiveDays(media) } } : {}),
    ...(media.seriesId ? { seriesId: library.graph.media(media.seriesId)?.canonicalId, seasonNumber: media.seasonNumber, episodeNumber: media.episodeNumber } : {}),
    playbackState: "UNRESOLVED"
  });
  return {
    descriptor: () => ({
      format: "boss-media-addon", version: 1, addonUrl: `${root}/addon.boss`, id: library.collectionId, name: library.collection.name,
      capabilities: { ...library.capabilities, categories: true },
      resources: { categories: `${root}/boss/categories`, catalogue: `${root}/boss/catalogue`, media: `${root}/boss/media/{id}`, ...(library.capabilities.streams ? { playback: `${root}/boss/playback/{id}` } : {}), ...(library.capabilities.subtitles ? { subtitles: `${root}/boss/subtitles/{id}` } : {}), ...(library.capabilities.epg ? { guide: `${root}/xmltv.xml` } : {}), ...(library.capabilities.catchup ? { catchup: `${root}/boss/catchup/{id}` } : {}) },
      pagination: { mode: "cursor", parameter: "after", maximumPageSize: 200 },
      playbackCapabilities: capabilityDescriptor(),
      playbackDelivery: { mode: "direct", proxiesMedia: false, rewritesHls: false, requiredHeaders: true },
      playbackNegotiation: { parameter: "boss_protocols", protocols: ["http", "hls", "dash"], defaults: ["http", "hls"] },
      security: { access: "private-link", torrents: false }
    }),
    categories(params) { return categoryPage(library, params); },
    async catalogue(params) {
      const after = Number(params.get("after") || 0), limit = Number(params.get("limit") || 100), skip = Number(params.get("skip") || 0);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new Error("Invalid catalogue pagination"), { status: 400 });
      if (!Number.isSafeInteger(skip) || skip < 0 || (after && skip)) throw Object.assign(new Error("Invalid search offset"), { status: 400 });
      const type = params.get("type");
      if (type && !library.capabilities.types.includes(type)) return { items: [], next: null };
      const options = { after, offset: skip, limit, ...(type ? { types: [type] } : {}), search: params.get("search") || "" };
      const category = params.get("categoryId");
      if (category !== null) options.categoryId = categoryNumber(category);
      if (params.get("seriesId")) options.seriesId = library.media(params.get("seriesId")).id;
      const items = options.search ? await library.search(options) : library.page(options);
      return { items: items.map(media => record(media, category)), next: items.length === limit ? String(items.at(-1).id) : null, ...(options.search ? { nextOffset: items.length === limit ? skip + items.length : null } : {}) };
    },
    async media(id) { return { media: record(await library.metadata(library.media(id))) }; },
    async playback(id, params = new URLSearchParams()) {
      const media = library.media(id);
      if (!["movie", "episode", "channel", "event"].includes(media.type)) return { id: media.canonicalId, resources: [] };
      return { id: media.canonicalId, ...await library.playbackChoices(media, { ...require("../core/player-capabilities").parseCapabilities(params), protocols: require("../core/playback-context").playbackProtocols(params) }) };
    },
    async catchup(id, params) {
      const media = library.media(id), context = { ...archiveContext(params), ...require("../core/player-capabilities").parseCapabilities(params), protocols: require("../core/playback-context").playbackProtocols(params) };
      if (!library.archiveDays(media)) throw Object.assign(new Error("Archive playback is not supported"), { status: 422 });
      return { id: media.canonicalId, ...await library.playbackChoices(media, context) };
    },
    async subtitles(id) { return { subtitles: (await library.subtitles(library.media(id))).map((item) => ({ id: item.id, language: item.language, ...require("../core/direct-resource").directResource(item.resource) })) }; }
  };
}
module.exports = { createBossOutput, archiveContext };

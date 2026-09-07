"use strict";
const Builder = require("stremio-addon-sdk/src/builder");
const { jsonArray } = require("./library");
const wireType = (type) => type === "channel" ? "tv" : type === "episode" ? "series" : type;
const canonicalType = (type) => type === "tv" ? "channel" : type;
const wireId = (media) => `boss:${media.canonicalId}`;
function meta(library, media) {
  const artwork = library.artwork(media);
  return { id: wireId(media), type: wireType(media.type), name: media.title, description: media.description || undefined, poster: artwork.poster || artwork.logo, background: artwork.backdrop, logo: artwork.logo, genres: media.genres, releaseInfo: media.year ? String(media.year) : undefined, runtime: media.runtimeSeconds ? `${Math.round(media.runtimeSeconds / 60)} min` : undefined, imdbRating: media.rating == null ? undefined : String(media.rating) };
}
function createAddonOutput(library) {
  const supported = library.capabilities;
  const types = supported.types.filter((type) => ["movie", "series", "channel"].includes(type)).map(wireType);
  const resources = ["catalog", "meta", ...(supported.streams ? ["stream"] : []), ...(supported.subtitles ? ["subtitles"] : [])];
  const builder = new Builder({ id: `com.bossmedia.${library.collectionId}`, version: "1.0.0", name: library.collection.name, description: "Boss Media Servers library", resources, types, idPrefixes: ["boss:"], catalogs: types.map((type) => ({ type, id: `boss-${type}`, name: { movie: "Movies", series: "Series", tv: "Live TV" }[type], extra: [{ name: "search" }, { name: "skip" }] })) });
  const item = (id) => library.media(String(id).replace(/^boss:/, ""));
  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (id !== `boss-${type}`) return { metas: [] };
    const options = { types: [canonicalType(type)], offset: Math.max(0, Number(extra.skip) || 0), search: String(extra.search || "").trim(), limit: 100 };
    const items = options.search ? await library.search(options) : library.page(options);
    return { metas: items.map((media) => meta(library, media)) };
  });
  builder.defineMetaHandler(async ({ id }) => ({ meta: meta(library, await library.metadata(item(id))) }));
  if (supported.streams) builder.defineStreamHandler(async ({ id }) => {
    const media = item(id);
    if (media.type === "series") return { streams: [] };
    const { resources } = await library.playbackChoices(media);
    return { streams: resources.map(resource => ({ name: resource.qualityLabel, title: [resource.title, resource.source.name].join("\n"), url: resource.url, behaviorHints: { notWebReady: true, ...(Object.keys(resource.requiredHeaders).length ? { proxyHeaders: { request: resource.requiredHeaders } } : {}) } })) };
  });
  if (supported.subtitles) builder.defineSubtitlesHandler(async ({ id }) => ({ subtitles: (await library.subtitles(item(id))).map((subtitle) => ({ id: subtitle.id, lang: subtitle.language, url: library.links.resource(subtitle.resource, subtitle.sourceId) })) }));
  const iface = builder.getInterface();
  // Series video arrays are streamed from indexed episode pages instead of materialized.
  async function* metadataBody(id) {
    const media = await library.metadata(item(id));
    const metadata = meta(library, media);
    if (media.type !== "series") { yield JSON.stringify({ meta: metadata }); return; }
    yield `{"meta":${JSON.stringify(metadata).slice(0, -1)},"videos":`;
    yield* jsonArray(library.items({ types: ["episode"], seriesId: media.id }), (episode) => ({ id: wireId(episode), title: episode.title, season: episode.seasonNumber, episode: episode.episodeNumber, released: episode.releaseDate || "1970-01-01T00:00:00Z" }));
    yield "}}";
  }
  return { ...iface, metadataBody };
}
module.exports = { createAddonOutput, wireId, descriptorFile: "manifest.json" };

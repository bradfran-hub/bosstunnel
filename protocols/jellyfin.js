"use strict";
const crypto = require("node:crypto");

const invalid = message => Object.assign(new Error(message), { status: 400 });
const unsupported = () => Object.assign(new Error("Unsupported Jellyfin item type"), { status: 422 });
const itemId = media => media.canonicalId.replaceAll("-", "");
function canonicalId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/i.test(value)) throw invalid("Invalid Jellyfin item ID");
  const id = value.toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

async function createJellyfinOutput(library) {
  const { BaseItemKind } = await import("@jellyfin/sdk/lib/generated-client/models/base-item-kind.js");
  const { CollectionType } = await import("@jellyfin/sdk/lib/generated-client/models/collection-type.js");
  const kinds = { movie: BaseItemKind.Movie, series: BaseItemKind.Series, season: BaseItemKind.Season, episode: BaseItemKind.Episode, channel: BaseItemKind.TvChannel, event: BaseItemKind.Program };
  const types = Object.fromEntries(Object.entries(kinds).map(([type, kind]) => [kind, type]));
  const definitions = [["movie", "Movies", CollectionType.Movies], ["series", "Series", CollectionType.Tvshows], ["channel", "Live TV", CollectionType.Livetv]].map(([type, name, collectionType]) => ({ type, name, collectionType, id: crypto.createHash("sha256").update(JSON.stringify(["jellyfin-view", library.collectionId, type])).digest("hex").slice(0, 32) }));
  const view = definition => ({ Id: definition.id, Name: definition.name, Type: BaseItemKind.CollectionFolder, CollectionType: definition.collectionType, IsFolder: true, ChildCount: library.count({ types: [definition.type] }) });
  const views = () => {
    const Items = definitions.map(view).filter(item => item.ChildCount > 0);
    return { Items, StartIndex: 0, TotalRecordCount: Items.length };
  };
  const artwork = media => {
    const available = library.engine.artwork(media.id, library.collection.sourceIds);
    return { Primary: available.poster || (media.type === "channel" ? available.logo : undefined), Backdrop: available.backdrop, Logo: available.logo, Thumb: available.thumbnail };
  };
  const imageTag = resource => crypto.createHmac("sha256", library.graph.secrets.key).update(JSON.stringify(["jellyfin-image", library.collectionId, resource.sourceId, library.graph.source(resource.sourceId)?.revision, resource.resource])).digest("hex").slice(0, 32);
  const related = id => {
    if (!id) return null;
    try { return library.media(id); } catch (error) { if (error.status === 404) return null; throw error; }
  };
  function record(input) {
    const media = library.authorize(input);
    if (!kinds[media.type]) throw unsupported();
    const folder = ["series", "season"].includes(media.type);
    const result = { Id: itemId(media), Name: media.title, Type: kinds[media.type], IsFolder: folder, ProviderIds: {} };
    if (!folder) result.MediaType = "Video";
    for (const [from, to] of Object.entries({ originalTitle: "OriginalTitle", year: "ProductionYear", description: "Overview", rating: "CommunityRating", certification: "OfficialRating", releaseDate: "PremiereDate" })) {
      if (media[from] != null) result[to] = media[from];
    }
    result.Genres = media.genres || [];
    for (const [from, to] of Object.entries({ imdb: "Imdb", tmdb: "Tmdb", tvdb: "Tvdb" })) if (media.externalIDs[from]) result.ProviderIds[to] = String(media.externalIDs[from]);
    const ticks = Math.round(media.runtimeSeconds * 10000000);
    if (media.runtimeSeconds != null && Number.isSafeInteger(ticks) && ticks >= 0) result.RunTimeTicks = ticks;
    const series = related(media.seriesId), season = related(media.seasonId);
    if (series) { result.SeriesId = itemId(series); result.SeriesName = series.title; }
    if (season) { result.SeasonId = itemId(season); result.SeasonName = season.title; }
    if (media.type === "episode") {
      result.IndexNumber = media.episodeNumber;
      result.ParentIndexNumber = media.seasonNumber;
      if (season || series) result.ParentId = itemId(season || series);
    }
    if (media.type === "season") {
      result.IndexNumber = media.seasonNumber;
      if (series) result.ParentId = itemId(series);
    }
    if (media.type === "channel" && media.channel?.number != null) result.ChannelNumber = String(media.channel.number);
    const images = artwork(media);
    const tags = Object.fromEntries(Object.entries(images).filter(([kind, value]) => kind !== "Backdrop" && value).map(([kind, value]) => [kind, imageTag(value)]));
    if (Object.keys(tags).length) result.ImageTags = tags;
    if (images.Backdrop) result.BackdropImageTags = [imageTag(images.Backdrop)];
    return result;
  }
  async function items({ startIndex = 0, limit = 100, includeItemTypes, searchTerm = "", parentId, enableTotalRecordCount = true, order } = {}) {
    if (!Number.isSafeInteger(startIndex) || startIndex < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalid("Invalid Jellyfin pagination");
    if (typeof enableTotalRecordCount !== "boolean") throw invalid("Invalid Jellyfin count option");
    const virtualParent = definitions.find(definition => definition.id === parentId);
    const parent = parentId && !virtualParent ? library.media(canonicalId(parentId)) : null;
    includeItemTypes ??= virtualParent ? [kinds[virtualParent.type]] : parent?.type === "season" ? [BaseItemKind.Episode] : parent?.type === "series" ? [BaseItemKind.Season] : [BaseItemKind.Movie, BaseItemKind.Series, BaseItemKind.TvChannel];
    if (!Array.isArray(includeItemTypes) || !includeItemTypes.length || includeItemTypes.length > 6 || includeItemTypes.some(type => !types[type])) throw unsupported();
    if (typeof searchTerm !== "string" || searchTerm.length > 1000) throw invalid("Invalid Jellyfin search");
    const query = { offset: startIndex, limit, types: [...new Set(includeItemTypes.map(type => types[type]))], search: searchTerm, order };
    if (virtualParent) query.types = query.types.filter(type => type === virtualParent.type);
    if (parent) {
      if (parent.type === "series") query.seriesId = parent.id;
      else if (parent.type === "season") query.seasonId = parent.id;
      else throw Object.assign(new Error("Parent browsing requires a series or season"), { status: 422 });
    }
    const rows = searchTerm ? await library.search(query) : library.page(query);
    return { Items: rows.map(record), StartIndex: startIndex, ...(enableTotalRecordCount ? { TotalRecordCount: library.count(query) } : {}) };
  }
  return { record, items, views, image: (id, type, index = 0) => {
    if (index !== 0 || !["Primary", "Backdrop", "Logo", "Thumb"].includes(type)) throw Object.assign(new Error("Image not found"), { status: 404 });
    const media = library.media(canonicalId(id)), resource = artwork(media)[type];
    if (!resource) throw Object.assign(new Error("Image not found"), { status: 404 });
    return resource;
  }, item: async id => {
    const definition = definitions.find(entry => entry.id === id);
    if (definition) return view(definition);
    return record(await library.metadata(library.media(canonicalId(id))));
  } };
}

module.exports = { createJellyfinOutput, itemId, canonicalId };

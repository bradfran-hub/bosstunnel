"use strict";
const { setImmediate: tick } = require("node:timers/promises");
const { capabilities } = require("../core/model");
class OutputLibrary {
  constructor(engine, collection, links) { this.engine = engine; this.graph = engine.graph; this.collectionId = collection.id; this.links = links; }
  get collection() { const value = this.graph.collection(this.collectionId); if (!value?.sourceIds.length) throw Object.assign(new Error("Library is unavailable"), { status: 404 }); return value; }
  get context() { const collection = this.collection; return { ...collection.profile, allowedSourceIds: collection.sourceIds }; }
  get capabilities() {
    const declarations = this.collection.sourceIds.map((id) => this.graph.source(id).capabilities);
    const values = {};
    for (const declaration of declarations) for (const [key, value] of Object.entries(declaration)) if (value === true) values[key] = true;
    values.catalog = true; values.search = true;
    values.types = [...new Set(declarations.flatMap((declaration) => declaration.types || []))];
    return capabilities(values);
  }
  authorize(media) {
    if (!media || !this.graph.mappings(media.id, this.collection.sourceIds).length) throw Object.assign(new Error("Media is outside this library"), { status: 404 });
    return this.project(media);
  }
  project(media) { return require("../core/library-metadata").libraryMetadata(this.graph, media, this.collection.sourceIds); }
  media(id) { return this.authorize(this.graph.media(id)); }
  synthetic(id) { return this.authorize(this.graph.fromSynthetic("xtream", Number(id))); }
  playbackExtension(media) {
    for (const mapping of this.graph.mappings(media.id, this.collection.sourceIds)) {
      const extension = String(mapping.resolverData.extension || "").toLowerCase();
      if (["mp4", "mkv", "webm", "mov", "m4v", "avi", "mpg", "mpeg", "ts", "m3u8", "m2ts", "mts", "ogv", "flv", "3gp"].includes(extension)) return extension;
    }
    return media.type === "channel" ? "ts" : "mp4";
  }
  archiveDays(media) {
    if (media.type !== "channel") return 0;
    let days = 0;
    for (const mapping of this.graph.mappings(media.id, this.collection.sourceIds)) {
      const declaration = this.graph.source(mapping.sourceId)?.capabilities;
      const window = Number(mapping.resolverData?.catchupDays);
      if (declaration?.streams && declaration.catchup && Number.isFinite(window) && window > 0 && window <= 365) days = Math.max(days, window);
    }
    return days;
  }
  page(options = {}) { return this.engine.page({ ...options, sourceIds: this.collection.sourceIds }).map(media => this.project(media)); }
  async search(options = {}) {
    await this.engine.search({ ...options, sourceIds: this.collection.sourceIds });
    // Membership may change while remote metadata is being retrieved.
    return this.page(options);
  }
  async *items(options = {}) {
    let after = 0;
    while (true) {
      const page = this.page({ ...options, after, limit: 200 });
      if (!page.length) return;
      for (const item of page) yield item;
      after = page.at(-1).id;
      await tick();
    }
  }
  async metadata(media) { this.authorize(media); return this.authorize(await this.engine.metadata(media.id, this.context)); }
  artwork(media) {
    const art = this.engine.artwork(media.id, this.collection.sourceIds);
    return Object.fromEntries(Object.keys(art).map((kind) => [kind, this.links.artwork(media, kind)]));
  }
  async resolve(media, context) {
    this.authorize(media);
    const collection = this.collection;
    const effective = require("../core/profile").constrainPlaybackContext(collection.profile, context);
    const result = await this.engine.resolve(media.id, { ...effective, allowedSourceIds: collection.sourceIds });
    if (this.collection.revision !== collection.revision) {
      throw Object.assign(new Error("Library changed during playback resolution; retry playback"), { status: 409 });
    }
    this.authorize(media);
    return result;
  }
  async subtitles(media) {
    this.authorize(media);
    const results = await this.engine.subtitles(media.id, this.context);
    const sources = this.collection.sourceIds;
    return results.filter((subtitle) => sources.includes(subtitle.sourceId) && this.graph.source(subtitle.sourceId)?.revision === subtitle.sourceRevision);
  }
}
async function* jsonArray(iterable, transform = (item) => item) {
  yield "["; let first = true;
  for await (const item of iterable) { if (!first) yield ","; first = false; yield JSON.stringify(await transform(item)); }
  yield "]";
}
module.exports = { OutputLibrary, jsonArray };

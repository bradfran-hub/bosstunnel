"use strict";
const { capabilities } = require("../core/model");
const { json, request } = require("./transport");
const { xmltv } = require("./xmltv");
const { httpMedia } = require("../stream-policy");
const { normalizeCandidate } = require("../core/resolver");
async function createBossSource(source) {
  const config = source.configuration;
  const address = config.baseUrl.replace(/\/$/, "");
  const parsed = new URL(address);
  if (!parsed.pathname.endsWith("/addon") && !parsed.pathname.endsWith(".boss")) parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/addon`;
  const entry = parsed.href;
  const origin = new URL(entry).origin;
  const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
  const descriptor = await json(entry, { headers, signal: AbortSignal.timeout(15000) });
  if (descriptor.format !== "boss-media-addon" || descriptor.version !== 1 || !descriptor.resources?.catalogue) throw new Error("Unsupported Boss addon version");
  const declaration = capabilities({ ...descriptor.capabilities, catalog: true, metadata: Boolean(descriptor.capabilities?.metadata && descriptor.resources.media), streams: Boolean(descriptor.capabilities?.streams && descriptor.resources.playback), subtitles: Boolean(descriptor.capabilities?.subtitles && descriptor.resources.subtitles), epg: Boolean(descriptor.capabilities?.epg && descriptor.capabilities?.types?.includes("channel") && descriptor.resources.guide), catchup: Boolean(descriptor.capabilities?.catchup && descriptor.capabilities?.streams && descriptor.capabilities?.types?.includes("channel") && descriptor.resources.catchup && descriptor.resources.playback), timeshift: false });
  const catalogs = declaration.types.filter((type) => ["movie", "series", "channel", "event"].includes(type)).map((type) => ({ key: type, type, title: `${descriptor.name}: ${type}`, enumerable: true, searchable: declaration.search }));
  function endpoint(resource, id, params) {
    const template = descriptor.resources[resource];
    if (!template) throw new Error("Boss resource is not supported");
    const url = new URL(template.replace("{id}", encodeURIComponent(id || "")), entry);
    if (url.origin !== origin || !httpMedia(url.href)) throw new Error("Boss API resource is outside the configured source");
    for (const [key, value] of Object.entries(params || {})) if (value != null) url.searchParams.set(key, String(value));
    return url.href;
  }
  async function call(resource, id, params, signal) {
    return json(endpoint(resource, id, params), { headers, signal: signal || AbortSignal.timeout(15000) });
  }
  function category(raw, type) {
    if (!raw || typeof raw.id !== "string" || !raw.id || raw.id.length > 256 || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 1024 || raw.type !== type) throw new Error("Invalid Boss category record");
    return { key: raw.id, name: raw.name, kind: type };
  }
  if (descriptor.capabilities?.categories && descriptor.resources.categories) {
    const signal = AbortSignal.timeout(15000);
    const feeds = [];
    for (const root of catalogs) {
      let after = null;
      const cursors = new Set(), ids = new Set();
      do {
        const page = await call("categories", null, { type: root.type, after, limit: 200 }, signal);
        if (!Array.isArray(page.categories) || page.categories.length > 200) throw new Error("Invalid Boss category page");
        for (const raw of page.categories) {
          const entry = category(raw, root.type);
          if (ids.has(entry.key) || feeds.length >= 4096) throw new Error("Boss categories exceed unique feed limit");
          ids.add(entry.key);
          feeds.push({ key: JSON.stringify({ categoryId: entry.key, type: root.type }), type: root.type, title: entry.name, enumerable: true, searchable: false, category: entry });
        }
        after = page.next ?? null;
        if (after !== null) {
          if (typeof after !== "string" || !after || after.length > 8192 || cursors.has(after) || cursors.size >= 4096) throw new Error("Invalid Boss category cursor");
          cursors.add(after);
        }
      } while (after !== null);
    }
    catalogs.push(...feeds);
  }
  const categoryFeeds = new Map(catalogs.filter(feed => feed.category).map(feed => [feed.key, feed]));
  function normalize(raw, seriesId) {
    const artwork = {};
    for (const [kind, url] of Object.entries(raw.artwork || {})) if (typeof url === "string" && httpMedia(url)) artwork[kind] = { url, headers: new URL(url).origin === origin ? headers : {} };
    return { sourceKey: raw.id, sourceType: raw.type, type: raw.type, title: raw.title, originalTitle: raw.originalTitle, year: raw.year, description: raw.description, genres: raw.genres, categories: raw.category == null ? [] : [category(raw.category, raw.type)], runtimeSeconds: raw.runtimeSeconds, rating: raw.rating, certification: raw.certification, releaseDate: raw.releaseDate, externalIDs: raw.identities, artwork, ...(raw.type === "channel" ? { channel: { number: raw.channel?.number, epgId: raw.channel?.epgId, catchupDays: declaration.catchup ? archiveDays(raw) : 0 }, resolverData: { catchupDays: declaration.catchup ? archiveDays(raw) : 0 } } : {}), ...(raw.type === "episode" ? { seriesId, seasonNumber: raw.seasonNumber, episodeNumber: raw.episodeNumber } : {}) };
  }
  function archiveDays(raw) {
    const days = Number(raw.channel?.catchupDays);
    return Number.isFinite(days) && days > 0 && days <= 365 ? days : 0;
  }
  function normalizeResource(resource) {
    if (!resource || typeof resource !== "object") return null;
    const candidate = normalizeCandidate({
      ...resource, resource: { url: resource.url },
      protocol: resource.protocol || (["hls", "dash"].includes(resource.transport) ? resource.transport : undefined),
      resolution: resource.resolution && typeof resource.resolution === "object" ? resource.resolution : null
    }, source.id);
    if (!candidate) return null;
    // API authentication is a same-origin default; explicit media authentication wins.
    if (new URL(candidate.resource.url).origin === origin && !Object.keys(candidate.requiredHeaders).some((key) => key.toLowerCase() === "authorization")) Object.assign(candidate.requiredHeaders, headers);
    return candidate;
  }
  async function catalog({ key, cursor, limit, query, signal }) {
    const feed = categoryFeeds.get(key);
    const child = !feed && key.startsWith("{") ? JSON.parse(key) : null;
    const type = feed ? feed.type : child ? "episode" : key;
    const page = await call("catalogue", null, { type, limit, ...(query ? { search: query, skip: cursor || 0 } : { after: cursor }), ...(child ? { seriesId: child.parent } : {}), ...(feed ? { categoryId: feed.category.key } : {}) }, signal);
    if (!Array.isArray(page.items) || page.items.length > limit) throw new Error("Invalid Boss catalogue page");
    const next = query ? page.nextOffset : page.next;
    return { items: page.items.map((raw) => {
      if (raw.type !== type) throw new Error("Boss catalogue returned an unexpected media type");
      const item = normalize(raw, child?.seriesId);
      if (feed) item.categories = [feed.category];
      return item;
    }), nextCursor: next == null ? null : String(next) };
  }
  return {
    id: source.id, capabilities: declaration, catalogs, catalog, search: catalog, resolutionTtlMs: 30000,
    async *epg({ signal }) {
      if (!declaration.epg) return;
      yield* xmltv((await request(endpoint("guide"), { headers, signal })).body);
    },
    async metadata(mapping, context) {
      const result = await call("media", mapping.sourceKey, {}, context.signal);
      if (!result.media) return null;
      const media = normalize(result.media, context.media.seriesId);
      if (media.type === "series" && declaration.types.includes("episode")) media.childCatalogs = [{ key: JSON.stringify({ parent: mapping.sourceKey, seriesId: context.media.id }), type: "episode", title: media.title, enumerable: true }];
      return media;
    },
    async resolve(media, mapping, context) {
      if (!mapping) return [];
      const page = await call(context.start == null ? "playback" : "catchup", mapping.sourceKey, context.start == null ? {} : { start: context.start, end: context.end }, context.signal);
      return (page.resources || []).map(normalizeResource).filter(Boolean);
    },
    async catchup(media, mapping, context) {
      if (!declaration.catchup || media.type !== "channel" || !mapping?.resolverData?.catchupDays || context.start < Date.now() - mapping.resolverData.catchupDays * 86400000) return [];
      return this.resolve(media, mapping, context);
    },
    async subtitles(media, mapping, context) {
      const page = await call("subtitles", mapping.sourceKey, {}, context.signal);
      return (page.subtitles || []).map((item) => {
        const candidate = normalizeResource(item);
        return candidate ? { id: item.id, language: item.language, resource: { url: candidate.resource.url, headers: candidate.requiredHeaders } } : null;
      }).filter(Boolean);
    }
  };
}
module.exports = { createBossSource };

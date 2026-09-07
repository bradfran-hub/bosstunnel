"use strict";
const parser = require("iptv-playlist-parser");
const crypto = require("node:crypto");
const { capabilities } = require("../core/model");
const { expiry } = require("../core/resolver");
const { httpMedia } = require("../stream-policy");
const { request, lines, pages } = require("./transport");
const { xmltv, probeXmltv } = require("./xmltv");

async function createM3uSource(source) {
  const config = source.configuration;
  let guideUrl = config.xmltvUrl;
  if (!guideUrl) {
    const response = await request(config.baseUrl, { signal: AbortSignal.timeout(8000) });
    let advertised, prefixBytes = 0;
    for await (const line of lines(response.body, 8192)) {
      prefixBytes += Buffer.byteLength(line) + 1;
      if (prefixBytes > 8192) throw new Error("Playlist header exceeds 8 KiB");
      if (!line.trim()) continue;
      if (!line.trimStart().startsWith("#EXTM3U")) throw new Error("Not an extended M3U library");
      const attrs = parser.parse(`${line}\n`).header.attrs;
      advertised = attrs?.["x-tvg-url"] || attrs?.["url-tvg"]; break;
    }
    if (advertised) {
      let target; try { target = new URL(advertised, config.baseUrl).href; } catch {}
      if (target && httpMedia(target) && await probeXmltv(target)) guideUrl = target;
    }
  }
  const caps = capabilities({ catalog: true, streams: true, live: true, epg: Boolean(guideUrl), types: ["movie", "channel"] });
  async function* records(signal) {
    const response = await request(config.baseUrl, { signal });
    let header = false; let record = [];
    for await (const line of lines(response.body)) {
      if (!line.trim()) continue;
      if (!header) { if (!line.trimStart().startsWith("#EXTM3U")) throw new Error("Not an extended M3U library"); header = true; continue; }
      if (line.startsWith("#EXT-X-")) throw new Error("Use a library playlist, not an HLS media playlist");
      if (line.startsWith("#")) { if (line.startsWith("#EXTINF:")) record = []; record.push(line); if (record.length > 32) throw new Error("Playlist entry has too many directives"); continue; }
      let url;
      try { url = new URL(line.trim(), config.baseUrl).toString(); } catch { record = []; continue; }
      if (!httpMedia(url)) { record = []; continue; }
      const entry = parser.parse(`#EXTM3U\n${record.join("\n")}\n${url}`).items[0]; record = [];
      if (!entry) continue;
      const type = config.mediaType === "movie" || /\.(mp4|mkv|m4v|mov)(?:\?|$)/i.test(url) ? "movie" : "channel";
      const sourceKey = entry.tvg?.id || crypto.createHash("sha256").update(JSON.stringify([type, entry.group?.title || "", entry.name])).digest("hex");
      const headers = { ...(entry.http?.referrer ? { Referer: entry.http.referrer } : {}), ...(entry.http?.["user-agent"] ? { "User-Agent": entry.http["user-agent"] } : {}) };
      yield { type, sourceKey, title: entry.name || "Untitled", genres: entry.group?.title ? [entry.group.title] : [], channel: type === "channel" ? { epgId: entry.tvg?.id || null } : undefined, artwork: entry.tvg?.logo ? { [type === "channel" ? "logo" : "poster"]: entry.tvg.logo } : {}, categories: entry.group?.title ? [{ key: entry.group.title, name: entry.group.title, kind: type }] : [], resolverData: { url, headers } };
    }
  }
  return {
    id: source.id, capabilities: caps, catalogs: [{ key: "playlist", title: "Playlist", enumerable: true }],
    scanCatalog: (context) => pages(records(context.signal), context),
    async resolve(media, mapping, context) {
      if (!mapping?.resolverData.url) return [];
      let data = mapping.resolverData;
      const url = new URL(data.url);
      const expires = expiry(url.searchParams.get("expires") || url.searchParams.get("exp") || url.searchParams.get("Expires"));
      if (expires && expires <= Date.now() + 10000) {
        for await (const record of records(context.signal)) if (record.sourceKey === mapping.sourceKey) { data = record.resolverData; break; }
      }
      return [{ resource: { url: data.url }, requiredHeaders: data.headers }];
    },
    async *epg({ signal }) { if (guideUrl) yield* xmltv((await request(guideUrl, { signal })).body); }
  };
}
module.exports = { createM3uSource };

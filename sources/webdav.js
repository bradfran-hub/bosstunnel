"use strict";
const { capabilities, titleKey } = require("../core/model");
const { BoundedCache } = require("../core/cache");
const { xmlElements, child, text, pages } = require("./transport");
const { httpMedia } = require("../stream-policy");
const { VIDEO, SUBTITLE, IMAGE, titleInfo, videoName, parseNfo } = require("./webdav-media");
const { createIndex } = require("./webdav-index");
const defined = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== ""));
const seasonFolder = name => /^(?:season[ ._-]*\d{1,3}|specials)$/i.test(name);

async function createWebDavSource(source, { caches } = {}) {
  const config = source.configuration;
  const root = new URL(`${config.baseUrl.replace(/\/$/, "")}/${(config.libraryPath || "").replace(/^\//, "").replace(/\/$/, "")}/`);
  root.pathname = root.pathname.replace(/\/{2,}/g, "/");
  if (root.search || root.hash || root.username || root.password || !httpMedia(root.href)) throw new Error("Invalid WebDAV root");
  const headers = config.username || config.password ? { Authorization: `Basic ${Buffer.from(`${config.username || ""}:${config.password || ""}`).toString("base64")}` }
    : config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
  const cache = caches?.sourceResponses || new BoundedCache({ maxEntries: 256, maxBytes: 4 * 1024 * 1024 });
  const metadataCaches = caches || { sourceResponses: cache };
  const sourceKey = url => decodeURIComponent(new URL(url).pathname.slice(root.pathname.length));
  function safeUrl(value, base = root) {
    try {
      const url = new URL(value, base);
      if (!httpMedia(url.href) || url.origin !== root.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(root.pathname)) return null;
      if (url.pathname.split("/").some(part => /[\\/\u0000-\u001f]/.test(decodeURIComponent(part)) || [".", ".."].includes(decodeURIComponent(part)))) return null;
      return url;
    } catch { return null; }
  }
  async function request(value, { signal, method = "GET", depth = "1" } = {}) {
    let url = safeUrl(value);
    if (!url) throw new Error("WebDAV resource is outside the configured root");
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(url, { method, signal, redirect: "manual", headers: { ...headers,
        ...(method === "PROPFIND" ? { Depth: depth, "Content-Type": "application/xml" } : {}) },
      ...(method === "PROPFIND" ? { body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getetag/><d:getlastmodified/></d:prop></d:propfind>' } : {}) });
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        url = location && safeUrl(location, url);
        if (!url || redirects === 3) throw new Error("Unsafe WebDAV redirect");
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`WebDAV returned HTTP ${response.status}`), { status: response.status }); }
      return response;
    }
  }
  async function* list(value, signal) {
    const parent = safeUrl(value);
    if (!parent) throw new Error("Invalid WebDAV directory");
    const response = await request(parent, { method: "PROPFIND", signal });
    for await (const row of xmlElements(response.body, "response")) {
      const href = text(row, "href"), item = href && safeUrl(href, parent);
      if (!item || item.pathname.replace(/\/$/, "") === parent.pathname.replace(/\/$/, "")) continue;
      const stat = row.children.find(c => c.name === "propstat" && /\s200(?:\s|$)/.test(text(c, "status")));
      if (!stat) throw new Error("WebDAV directory contains unreadable entries");
      const prop = child(stat, "prop"), directory = Boolean(child(child(prop, "resourcetype"), "collection"));
      if (directory && !item.pathname.endsWith("/")) item.pathname += "/";
      if (!item.pathname.startsWith(parent.pathname)) continue;
      const relative = item.pathname.slice(parent.pathname.length).replace(/\/$/, "");
      if (!relative || relative.includes("/")) continue;
      // Actual resource names, rather than display labels, bind files to their sidecars.
      yield { url: item.href, parent: parent.href, name: decodeURIComponent(relative), directory: Number(directory),
        etag: text(prop, "getetag") || null, modified: text(prop, "getlastmodified") || null };
    }
  }
  const probe = await request(root, { method: "PROPFIND", depth: "0" });
  if (probe.status !== 207) { await probe.body?.cancel(); throw new Error("Server did not return a WebDAV multistatus response"); }
  let validProbe = false;
  for await (const row of xmlElements(probe.body, "response")) {
    validProbe = row.children.some(c => c.name === "propstat" && /\s200(?:\s|$)/.test(text(c, "status")));
    if (validProbe) break;
  }
  if (!validProbe) throw new Error("WebDAV root could not be read");

  async function nfo(entry, signal) {
    if (!entry) return {};
    const key = `${source.id}:${source.revision}:dav-nfo:${entry.url}:${entry.etag || entry.modified || ""}`;
    const hit = cache.get(key); if (hit) return hit;
    try {
      const response = await request(entry.url, { signal });
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error("NFO exceeds 1 MB"); chunks.push(chunk); }
      const result = parseNfo(Buffer.concat(chunks).toString());
      cache.set(key, result, entry.etag || entry.modified ? 3600000 : 30000);
      return result;
    } catch (error) { if (signal?.aborted || [401, 403, 429].includes(error.status)) throw error; return {}; }
  }
  const localArt = (metadata, directory) => Object.fromEntries(Object.entries(metadata.artwork || {}).flatMap(([kind, value]) => {
    const url = safeUrl(value, directory); return url && IMAGE.test(url.pathname) ? [[kind, { url: url.href, headers }]] : [];
  }));
  async function* scan(context) {
    const index = createIndex(), db = index.db;
    const findEntry = db.prepare("SELECT * FROM Entries WHERE parent=? AND name=? COLLATE NOCASE AND directory=0 LIMIT 2");
    const entryPage = db.prepare("SELECT * FROM Entries WHERE parent=? AND url>? ORDER BY url LIMIT 200");
    function* entries(parent) {
      let after = "", rows;
      while ((rows = entryPage.all(parent, after)).length) { yield* rows; after = rows.at(-1).url; }
    }
    const find = (parent, name) => {
      const matches = findEntry.all(parent, name);
      return matches.length === 1 ? matches[0] : null;
    };
    const artwork = (parent, stem, generic, metadata) => {
      const result = {};
      for (const [kind, names] of Object.entries({ poster: [`${stem}-poster`, ...(generic ? ["poster", "folder", "cover"] : [])], backdrop: [`${stem}-fanart`, ...(generic ? ["fanart", "backdrop"] : [])], logo: [`${stem}-logo`, ...(generic ? ["logo", "clearlogo"] : [])], thumbnail: [`${stem}-thumb`] })) {
        for (const name of names) for (const ext of ["jpg", "jpeg", "png", "webp"]) {
          const entry = find(parent, `${name}.${ext}`);
          if (entry && !result[kind]) result[kind] = { url: entry.url, headers };
        }
      }
      return { ...result, ...localArt(metadata, parent) };
    };
    const seriesRecord = (directory, name, metadata = {}) => {
      const parsed = titleInfo(name), art = artwork(directory, "tvshow", true, metadata);
      return { ...parsed, ...defined(metadata), externalIDs: { ...parsed.externalIDs, ...metadata.externalIDs },
        type: "series", sourceKey: `boss-webdav-series:${sourceKey(directory)}`, sourceType: "series",
        artwork: art, resolverData: { directory, localArtwork: art } };
    };
    db.prepare("INSERT INTO Folders(url,depth,context) VALUES(?,0,'{}')").run(root.href);
    try {
      let folder;
      while ((folder = db.prepare("SELECT * FROM Folders WHERE done=0 ORDER BY id LIMIT 1").get())) {
        context.signal?.throwIfAborted();
        if (folder.depth > 64) throw new Error("WebDAV nesting exceeds 64 directories");
        let batch = [];
        for await (const entry of list(folder.url, context.signal)) { batch.push(entry); if (batch.length === 200) { index.add(batch); batch = []; } }
        if (batch.length) index.add(batch);
        const inherited = JSON.parse(folder.context);
        const showNfo = await nfo(find(folder.url, "tvshow.nfo"), context.signal);
        const folderName = decodeURIComponent(new URL(folder.url).pathname.split("/").at(-2));
        let hasSeasons = false, videos = 0;
        for (const entry of db.prepare("SELECT name,directory FROM Entries WHERE parent=?").iterate(folder.url)) {
          if (entry.directory && seasonFolder(entry.name)) hasSeasons = true;
          if (!entry.directory && VIDEO.test(entry.name)) videos++;
        }
        const series = showNfo.type === "series" || hasSeasons ? seriesRecord(folder.url, folderName, showNfo) : inherited.series;
        const movieNfo = videos === 1 ? await nfo(find(folder.url, "movie.nfo"), context.signal) : {};
        for (const entry of entries(folder.url)) {
          context.signal?.throwIfAborted();
          if (entry.directory) {
            db.prepare("INSERT OR IGNORE INTO Folders(url,depth,context) VALUES(?,?,?)").run(entry.url, folder.depth + 1, JSON.stringify({ ...(series ? { series } : {}) }));
            continue;
          }
          const parsed = videoName(entry.name); if (!parsed) continue;
          const local = await nfo(find(folder.url, `${parsed.stem}.nfo`), context.signal);
          const episodeNfo = local.type === "episode" && Number.isInteger(local.seasonNumber) && local.seasonNumber >= 0 && Number.isInteger(local.episodeNumber) && local.episodeNumber >= 0;
          const type = episodeNfo || parsed.type === "episode" ? "episode" : "movie";
          const metadata = type === "movie" ? { ...movieNfo, ...local } : local;
          const filename = titleInfo(parsed.stem), art = artwork(folder.url, parsed.stem, type === "movie" && videos === 1, metadata);
          const record = { ...filename, ...defined(metadata), externalIDs: { ...filename.externalIDs, ...metadata.externalIDs }, type, sourceType: type, sourceKey: sourceKey(entry.url),
            artwork: art, resolverData: { url: entry.url, container: parsed.container, extension: parsed.container, stream: metadata.stream || {}, localArtwork: art, etag: entry.etag, modified: entry.modified } };
          if (type === "movie") {
            const folderIdentity = videos === 1 ? titleInfo(folderName) : {};
            record.externalIDs = { ...folderIdentity.externalIDs, ...record.externalIDs };
            if (!record.year && folderIdentity.year && titleKey(record.title) === titleKey(folderIdentity.title)) record.year = folderIdentity.year;
            record.categories = [{ key: "movies", name: "Movies", kind: "movie" }, ...(record.genres || []).map(name => ({ key: `genre:${name}`, name, kind: "movie" }))];
            yield record; continue;
          }
          const parent = series || seriesRecord(folder.url, local.showTitle || parsed.series?.title || folderName);
          const show = { ...parent, sourceKey: series ? parent.sourceKey : `${parent.sourceKey}:${titleKey(local.showTitle || parsed.series?.title || folderName)}` };
          if (!series && parsed.series?.year) show.year = parsed.series.year;
          if (!series) show.externalIDs = { ...parsed.series?.externalIDs, ...show.externalIDs };
          show.categories = [{ key: "series", name: "Series", kind: "series" }, ...(show.genres || []).map(name => ({ key: `genre:${name}`, name, kind: "series" }))];
          yield show;
          const numbers = episodeNfo ? [local.episodeNumber] : parsed.episodeNumbers;
          for (const episodeNumber of numbers) yield { ...record, externalIDs: local.externalIDs || {}, title: local.title || (numbers.length > 1 ? `Episode ${episodeNumber}` : parsed.title),
            sourceKey: numbers.length > 1 ? `${record.sourceKey}#episode=${episodeNumber}` : record.sourceKey,
            seriesRef: { sourceType: "series", sourceKey: show.sourceKey }, seasonNumber: episodeNfo ? local.seasonNumber : parsed.seasonNumber, episodeNumber,
            resolverData: { ...record.resolverData, series: { type: "series", title: show.title, year: show.year, externalIDs: show.externalIDs } } };
        }
        db.prepare("UPDATE Folders SET done=1 WHERE id=?").run(folder.id);
      }
    } finally { index.close(); }
  }
  return { id: source.id, capabilities: capabilities({ catalog: true, metadata: true, streams: true, subtitles: true, types: ["movie", "series", "episode"] }),
    episodesInCatalog: true, catalogs: [{ key: "files", title: "Files", type: "movie", enumerable: true }],
    scanCatalog: context => pages(scan(context), context), resolutionTtlMs: 30000,
    async metadata(mapping, context) {
      const media = context.media;
      const input = { ...media, sourceType: mapping.sourceType, sourceKey: mapping.sourceKey, resolverData: mapping.resolverData };
      try {
        const { cinematographicMetadata } = require("./cinemeta");
        const { normalizeMetadata } = require("./addon");
        const remote = await cinematographicMetadata(media.type === "episode" ? mapping.resolverData.series || {} : media, { signal: context.signal, caches: metadataCaches });
        if (remote) {
          const normalized = media.type === "episode" ? {} : normalizeMetadata(remote, media.type);
          if (Object.entries(normalized.externalIDs || {}).some(([ns, id]) => id && media.externalIDs?.[ns] && String(id) !== String(media.externalIDs[ns]))) return input;
          const video = media.type === "episode" && remote.videos?.find(v => v.season === media.seasonNumber && v.episode === media.episodeNumber);
          for (const key of ["originalTitle", "year", "description", "runtimeSeconds", "rating", "certification", "releaseDate"]) if (!input[key] && normalized[key]) input[key] = normalized[key];
          if (!input.genres?.length && normalized.genres?.length) input.genres = normalized.genres;
          input.externalIDs = { ...normalized.externalIDs, ...media.externalIDs };
          input.artwork = normalized.artwork || {};
          if (video) { if (/^Episode \d+$/.test(input.title)) input.title = video.title || input.title; if (!input.releaseDate) input.releaseDate = video.released; if (video.thumbnail) input.artwork.thumbnail = video.thumbnail; }
        }
      } catch { context.signal?.throwIfAborted(); }
      input.artwork = { ...input.artwork, ...mapping.resolverData.localArtwork };
      // Metadata failure never blocks an indexed file or creates unowned episodes.
      return input;
    },
    async resolve(media, mapping) {
      if (!mapping || !["movie", "episode"].includes(media.type)) return [];
      const url = safeUrl(mapping.resolverData.url);
      return url ? [{ ...mapping.resolverData.stream, resource: { url: url.href }, requiredHeaders: headers, container: mapping.resolverData.container, protocol: mapping.resolverData.container === "m3u8" ? "hls" : "http" }] : [];
    },
    async subtitles(media, mapping, context) {
      if (!mapping?.resolverData.url || !["movie", "episode"].includes(media.type)) return [];
      const url = safeUrl(mapping.resolverData.url); if (!url) return [];
      const name = decodeURIComponent(url.pathname.split("/").at(-1)), stem = name.replace(VIDEO, "");
      const results = [];
      for await (const entry of list(new URL("./", url), context.signal)) {
        if (entry.directory || !SUBTITLE.test(entry.name)) continue;
        const base = entry.name.replace(SUBTITLE, "");
        if (base.toLowerCase() !== stem.toLowerCase() && !base.toLowerCase().startsWith(`${stem.toLowerCase()}.`)) continue;
        const language = base.slice(stem.length).split(".").find(part => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(part)) || "und";
        results.push({ id: sourceKey(entry.url), language: language.toLowerCase(), resource: { url: entry.url, headers } });
        if (results.length === 200) break;
      }
      return results;
    }
  };
}
module.exports = { createWebDavSource };

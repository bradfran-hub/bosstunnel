"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
let app, upstream, base, sourceUrl, dir;
const token = "test-admin-token-with-at-least-24-characters";
const seen = [];
let renewalVersion = 1;
const guideStart = Math.floor(Date.now() / 3600000) * 3600000;
const xmlTime = (value) => new Date(value).toISOString().replace(/[-:T]/g, "").slice(0, 14);
function reply(res, data) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); }
before(async () => {
  dir = await fs.mkdtemp(`${os.tmpdir()}/boss-test-`);
  process.env.BOSS_ADMIN_TOKEN = token;
  process.env.BOSS_SECRET = "test-encryption-key-at-least-32-characters";
  process.env.DATA_DIR = dir;
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://mock"); seen.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
    if (url.pathname === "/dash-test/seg-00007.m4s") {
      assert.equal(req.headers.authorization, "Bearer dash-segment-key");
      res.writeHead(200, { "Content-Type": "video/iso.segment" }); return res.end("unaltered-dash-segment");
    }
    if (url.pathname === "/dash-test/show.mpd") {
      assert.equal(req.headers.authorization, "Bearer dash-segment-key");
      res.writeHead(200, { "Content-Type": "application/dash+xml" });
      return res.end('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><Period><AdaptationSet><Representation id="v" bandwidth="100"><SegmentTemplate startNumber="7" media="seg-$Number%05d$.m4s"/></Representation></AdaptationSet></Period></MPD>');
    }
    if (url.pathname === "/limited/manifest.json") return reply(res, { id: "test.limited", version: "1.0.0", name: "Limited", types: ["movie"], resources: ["catalog", "stream"], catalogs: [{ id: "limited", type: "movie" }] });
    if (url.pathname.startsWith("/limited/catalog/")) return reply(res, { metas: [{ id: "tt0251160", name: "John Q", type: "movie" }] });
    if (url.pathname.startsWith("/limited/stream/")) return reply(res, { streams: [{ url: `${sourceUrl}/limited/file-one` }, { url: `${sourceUrl}/limited/file-two` }] });
    if (url.pathname.startsWith("/limited/file-")) { res.writeHead(429, { "Retry-After": "120" }); return res.end("Private upstream diagnostic"); }
    if (url.pathname.startsWith("/boss-captions/")) {
      if (url.pathname.endsWith("/text")) {
        assert.equal(req.headers.authorization, "Bearer subtitle-only");
        assert.equal(req.headers.referer, `${sourceUrl}/player`);
        res.setHeader("Content-Type", "application/x-subrip"); return res.end("1\n00:00:00,000 --> 00:00:01,000\nAuthorized subtitle\n");
      }
      assert.equal(req.headers.authorization, "Bearer private-api-key");
      if (url.pathname.endsWith("/addon")) return reply(res, { format: "boss-media-addon", version: 1, capabilities: { catalog: true, subtitles: true, types: ["movie"] }, resources: { catalogue: `${sourceUrl}/boss-captions/catalogue`, subtitles: `${sourceUrl}/boss-captions/subtitles/{id}` } });
      if (url.pathname.endsWith("/catalogue")) return reply(res, { items: [{ id: "film", type: "movie", title: "Captioned film" }], next: null });
      return reply(res, { subtitles: [
        null,
        { id: "english", language: "eng", url: `${sourceUrl}/boss-captions/text`, requiredHeaders: { Authorization: "Bearer subtitle-only", Referer: `${sourceUrl}/player` } },
        { id: "expired", language: "eng", url: `${sourceUrl}/expired-caption`, expiresAt: Date.now() - 10000 },
        { id: "forbidden", language: "eng", url: `${sourceUrl}/blocked.torrent` }
      ] });
    }
    if (url.pathname === "/boss-live/addon") return reply(res, { format: "boss-media-addon", version: 1, name: "Live fixture", capabilities: { catalog: true, live: true, epg: true, types: ["channel"] }, resources: { catalogue: `${sourceUrl}/boss-live/catalogue`, guide: `${sourceUrl}/guide.xml` } });
    if (url.pathname === "/boss-live/catalogue") return reply(res, { items: [{ id: "native-channel", type: "channel", title: "News & Weather", channel: { number: "42", epgId: "guide.one", catchupDays: 7, timeshiftSeconds: 3600 } }], next: null });
    if (url.pathname.startsWith("/library/")) {
      assert.equal(req.headers["x-plex-token"], "private-api-key");
      if (url.pathname === "/library/sections") return reply(res, { MediaContainer: { Directory: [{ key: "1", type: "movie", title: "Movies" }, { key: "2", type: "show", title: "Shows" }] } });
      if (url.pathname.startsWith("/library/parts/")) { res.setHeader("Content-Type", "video/mp4"); return res.end("plex-media"); }
      const type = url.pathname.includes("allLeaves") ? "episode" : url.pathname.includes("sections/2/") || url.pathname === "/library/metadata/plex-series" ? "show" : "movie";
      const id = type === "show" ? "plex-series" : type === "episode" ? "plex-episode" : "plex-movie";
      const raw = { ratingKey: id, type, title: `Plex ${type}`, parentIndex: 1, index: 1, Guid: [{ id: type === "movie" ? "imdb://tt0251160" : "imdb://tt0903747" }], Genre: [{ tag: "Drama" }], Media: [{ container: "mp4", videoCodec: "h264", width: 1280, height: 720, Part: [{ key: `/library/parts/${id}/file.mp4`, container: "mp4", Stream: [{ streamType: 1, codec: "h264", width: 1280, height: 720 }, { streamType: 2, codec: "aac", languageCode: "eng" }] }] }] };
      const offset = Number(req.headers["x-plex-container-start"] || 0);
      return reply(res, { MediaContainer: { offset, totalSize: 1, Metadata: offset ? [] : [raw] } });
    }
    if (/^\/(text-only|text-fallback)\/manifest.json$/.test(url.pathname)) return reply(res, { id: "test.text", version: "1.0.0", name: "Text response", types: ["movie"], resources: ["catalog", "stream"], catalogs: [{ id: "text", type: "movie" }] });
    if (/^\/(text-only|text-fallback)\/catalog\//.test(url.pathname)) return reply(res, { metas: [{ id: "tt0251160", name: "John Q", type: "movie" }] });
    if (/^\/(text-only|text-fallback)\/stream\//.test(url.pathname)) return reply(res, { streams: [{ url: `${sourceUrl}/cached-notice` }, ...(url.pathname.startsWith("/text-fallback/") ? [{ url: `${sourceUrl}/resolved-debrid.mp4` }] : [])] });
    if (url.pathname === "/cached-notice") { res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="TGx.txt"' }); return res.end("Torrent downloaded from torrentgalaxy.to"); }
    if (/^\/(search-only|search-broken)\/manifest.json$/.test(url.pathname)) return reply(res, { id: "test.search", version: "1.0.0", name: "Search", types: ["movie"], resources: ["catalog", "stream"], catalogs: [{ id: "search", type: "movie", extra: [{ name: "search", isRequired: true }, { name: "skip" }] }] });
    if (/^\/(search-only|search-broken)\/catalog\//.test(url.pathname)) {
      if (url.pathname.startsWith("/search-broken/")) { res.writeHead(503); return res.end(); }
      const extra = new URLSearchParams(url.pathname.split("/").at(-1).replace(/\.json$/, ""));
      assert.equal(extra.get("search"), "Discovery");
      const skip = Number(extra.get("skip") || 0);
      return reply(res, { metas: Array.from({ length: Math.min(100, Math.max(0, 300 - skip)) }, (_, index) => ({ id: `discovery-${skip + index}`, name: `Discovery ${skip + index}`, type: "movie" })) });
    }
    if (url.pathname.startsWith("/search-only/stream/")) return reply(res, { streams: [{ url: `${sourceUrl}/resolved-debrid.mp4` }] });
    if (/^\/(renewal|unavailable)\/manifest.json$/.test(url.pathname)) return reply(res, { id: "test.renewal", version: "1.0.0", name: "Renewal", types: ["movie"], resources: ["catalog", "stream"], catalogs: [{ id: "renewal", type: "movie" }] });
    if (/^\/(renewal|unavailable)\/catalog\//.test(url.pathname)) return reply(res, { metas: [{ id: "renewal-film", type: "movie", name: "Renewal film" }] });
    if (/^\/(renewal|unavailable)\/stream\//.test(url.pathname)) return reply(res, { streams: [{ url: `${sourceUrl}/${url.pathname.startsWith("/unavailable/") ? "unavailable.mp4" : `renewal-${renewalVersion}.mp4`}` }] });
    if (url.pathname === "/unavailable.mp4" || /^\/renewal-\d+.mp4$/.test(url.pathname)) {
      if (url.pathname !== `/renewal-${renewalVersion}.mp4`) { res.writeHead(403); return res.end(); }
      res.setHeader("Content-Type", "video/mp4"); return res.end(`renewal-${renewalVersion}`);
    }
    if (url.pathname === "/poster.png") { res.setHeader("Content-Type", "image/png"); return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSAAAAABJRU5ErkJggg==", "base64")); }
    if (/^\/(captions|broken-captions)\/manifest.json$/.test(url.pathname)) return reply(res, { id: "test.captions", version: "1.0.0", name: "Captions", resources: ["catalog", "subtitles"], types: ["movie"], catalogs: [{ id: "captions", type: "movie" }] });
    if (/^\/(captions|broken-captions)\/catalog\//.test(url.pathname)) return reply(res, { metas: [{ id: "tt1375666", name: "Inception", type: "movie" }] });
    if (url.pathname.startsWith("/broken-captions/subtitles/")) { res.writeHead(503); return res.end(); }
    if (url.pathname.startsWith("/captions/subtitles/")) return reply(res, { subtitles: [{ id: "english", lang: "eng", url: `${sourceUrl}/captions.srt` }, { id: "torrent", lang: "eng", url: `${sourceUrl}/blocked.torrent` }] });
    if (url.pathname === "/captions.srt" || /^\/Videos\/[^/]+\/variant\/Subtitles\/2\/Stream.srt$/.test(url.pathname)) {
      if (url.pathname.startsWith("/Videos/")) assert.ok(req.headers.authorization || req.headers["x-emby-token"]);
      res.setHeader("Content-Type", "application/x-subrip"); return res.end("1\n00:00:00,000 --> 00:00:01,000\nAuthorized subtitle\n");
    }
    if (url.pathname === "/profiles/manifest.json") return reply(res, { id: "test.profiles", version: "1.0.0", name: "Profile source", types: ["movie"], resources: ["catalog", "stream"], catalogs: [{ id: "profile", type: "movie" }] });
    if (url.pathname.startsWith("/profiles/catalog/")) return reply(res, { metas: [{ id: "profile-film", type: "movie", name: "Profile film" }] });
    if (url.pathname.startsWith("/profiles/stream/")) return reply(res, { streams: [{ url: `${sourceUrl}/quality-hevc.mp4`, codec: "hevc", resolution: { height: 2160 }, languages: ["fr"], hdr: "HDR10" }, { url: `${sourceUrl}/quality-h264.mp4`, codec: "h264", resolution: { height: 720 }, languages: ["en"] }, { url: `${sourceUrl}/quality-unknown.mp4`, resolution: { height: 720 }, languages: ["en"] }] });
    if (url.pathname.startsWith("/quality-")) { res.setHeader("Content-Type", "video/mp4"); return res.end(url.pathname); }
    if (url.pathname === "/live.m3u") return res.end(`#EXTM3U\n#EXTINF:-1 tvg-id="guide.one" group-title="News",News & Weather\n${sourceUrl}/segment.ts\n`);
    if (url.pathname === "/guide.xml") { res.setHeader("Content-Type", "application/xml"); return res.end(`<tv><programme channel="guide.one" start="${xmlTime(guideStart)}" stop="${xmlTime(guideStart + 7200000)} +0000"><title>News &amp; Weather</title><desc>Today's &lt;headlines&gt;</desc></programme><programme channel="unknown" start="${xmlTime(guideStart)}" stop="${xmlTime(guideStart + 7200000)}"><title>Outside library</title></programme></tv>`); }
    if (url.pathname === "/bad-guide.xml") return res.end("<tv><programme>");
    if (url.pathname === "/identity/manifest.json") return reply(res, { id: "test.identity", version: "1.0.0", name: "Identity catalogue", types: ["movie"], resources: ["catalog", "stream"], catalogs: [{ id: "identity", type: "movie" }] });
    if (url.pathname.startsWith("/identity/catalog/")) return reply(res, { metas: [{ id: "tt1375666", type: "movie", name: "Inception" }] });
    if (url.pathname.startsWith("/identity/stream/")) return reply(res, { streams: [] });
    if (url.pathname === "/resolver/manifest.json") return reply(res, { id: "test.resolver", version: "1.0.0", name: "Authorized resolver", types: ["movie"], idPrefixes: ["tt"], resources: ["stream"], catalogs: [] });
    if (url.pathname.startsWith("/resolver/stream/")) return reply(res, { streams: [{ url: `${sourceUrl}/resolved-debrid.mp4` }] });
    if (url.pathname === "/Items") {
      const ids = url.searchParams.get("ids") || url.searchParams.get("Ids");
      const types = url.searchParams.get("includeItemTypes") || url.searchParams.get("IncludeItemTypes");
      const type = ids === "series1" || types === "Series" ? "Series" : types === "Episode" ? "Episode" : "Movie";
      const raw = { Id: type === "Series" ? "series1" : type === "Episode" ? "episode1" : ids || "movie1", Type: type, Name: "Test Media", ImageTags: { Primary: "image" }, ParentIndexNumber: 1, IndexNumber: 2 };
      raw.MediaSources = [{ Id: "variant", Container: "mp4", MediaStreams: [{ Type: "Subtitle", Index: 2, IsExternal: true, Codec: "srt", Language: "eng" }, { Type: "Subtitle", Index: 3, IsExternal: true, Codec: "pgssub", Language: "eng" }] }];
      return reply(res, { Items: ids === "missing" ? [] : [raw] });
    }
    if (/^\/Videos\//.test(url.pathname)) {
      assert.ok(req.headers.authorization || req.headers["x-emby-token"]);
      if (req.headers.range) { res.writeHead(206, { "Content-Range": "bytes 0-3/10", "Content-Length": "4", "Content-Type": "video/mp4", "Accept-Ranges": "bytes" }); return res.end("test"); }
      return res.end("test-video");
    }
    if (/^\/(remote|hls|mime|redirect)\/manifest.json$/.test(url.pathname)) return reply(res, { id: "test.remote", version: "1.0.0", name: "Remote", types: ["movie"], resources: ["catalog", "meta", "stream"], catalogs: [{ id: "remote", type: "movie", extra: [{ name: "search" }, { name: "skip" }] }] });
    if (/^\/(remote|hls|mime|redirect)\/catalog\//.test(url.pathname)) return reply(res, { metas: [{ id: "remote:id/1", type: "movie", name: "Remote Movie", poster: `${sourceUrl}/poster.png` }] });
    if (/^\/(hls|mime|redirect)\/stream\//.test(url.pathname)) return reply(res, { streams: [{ url: `${sourceUrl}/${url.pathname.split("/")[1] === "hls" ? "stream.m3u8" : url.pathname.split("/")[1] === "mime" ? "torrent-content" : "redirect-content"}` }] });
    if (url.pathname === "/torrent-content") { res.setHeader("Content-Type", "application/x-bittorrent"); return res.end("torrent-payload"); }
    if (url.pathname === "/redirect-content") { res.writeHead(302, { Location: `${sourceUrl}/blocked.torrent` }); return res.end(); }
    if (url.pathname === "/stream.m3u8") { res.setHeader("Content-Type", "application/vnd.apple.mpegurl"); return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n'); }
    if (url.pathname === "/segment.ts") { res.setHeader("Content-Type", "video/mp2t"); return res.end("hls-segment"); }
    if (url.pathname.startsWith("/remote/meta/")) return reply(res, { meta: { id: "remote:id/1", type: "movie", name: "Remote Movie", videos: [{ id: "episode:1", title: "Episode" }] } });
    if (url.pathname.startsWith("/remote/stream/")) return reply(res, { streams: [{ url: `${sourceUrl}/resolved-debrid.mp4` }, { infoHash: "abcdef", url: `${sourceUrl}/unsafe.mp4` }, { url: "magnet:?xt=urn:btih:abc" }, { url: `${sourceUrl}/file.torrent` }] });
    if (url.pathname === "/resolved-debrid.mp4") { res.setHeader("Content-Type", "video/mp4"); return res.end("resolved-http-media"); }
    if (url.pathname === "/playlist.m3u") return res.end(`#EXTM3U\n#EXTINF:-1,Movie\n${sourceUrl}/resolved-debrid.mp4\n#EXTINF:-1,Forbidden\nmagnet:?xt=urn:btih:abc\n`);
    if (url.pathname === "/player_api.php") {
      assert.equal(url.searchParams.get("username"), "source-user");
      assert.equal(url.searchParams.get("password"), "source-password");
      const action = url.searchParams.get("action");
      if (!action) return reply(res, { user_info: { auth: 1 }, server_info: { timezone: "America/New_York" } });
      if (action === "get_live_streams") return reply(res, [{ stream_id: 1, name: "Live channel", epg_channel_id: "guide.one", tv_archive: 1, tv_archive_duration: 2 }]);
      if (action === "get_vod_streams") return reply(res, [{ stream_id: 2, name: "Movie", container_extension: "mp4" }]);
      if (action === "get_series") return reply(res, [{ series_id: 3, name: "Show" }]);
      if (action === "get_series_info") return reply(res, { episodes: { "1": [{ id: 4, title: "Episode", season: 1, episode_num: 1, container_extension: "mp4" }] } });
    }
    if (/^\/(live|movie|series)\/source-user\/source-password\//.test(url.pathname)) { res.setHeader("Content-Type", "video/mp4"); return res.end("xtream-media"); }
    if (/^\/timeshift\/source-user\/source-password\//.test(url.pathname)) { res.setHeader("Content-Type", "video/mp2t"); return res.end("archive-media"); }
    if (req.method === "PROPFIND") {
      assert.equal(req.headers.authorization, "Basic " + Buffer.from("user:pass").toString("base64"));
      res.writeHead(207, { "Content-Type": "application/xml" });
      return res.end('<?xml version="1.0"?><x:multistatus xmlns:x="DAV:"><x:response><x:href>/dav/Movie%20%26%20One.mp4</x:href><x:propstat><x:prop><x:displayname>Movie &amp; One.mp4</x:displayname><x:getcontentlength>10</x:getcontentlength><x:resourcetype/><x:getcontenttype>video/mp4</x:getcontenttype></x:prop><x:status>HTTP/1.1 200 OK</x:status></x:propstat></x:response></x:multistatus>');
    }
    if (url.pathname === "/dav/Movie%20%26%20One.mp4") { assert.ok(req.headers.authorization); return res.end("dav-media"); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => upstream.listen(0, "0.0.0.0", resolve));
  sourceUrl = `http://127.0.0.1:${upstream.address().port}`;
  process.env.PUBLIC_BASE_URL = "http://placeholder/bossmedia";
  app = require("../server").server;
  await new Promise((resolve) => app.listen(0, "0.0.0.0", resolve));
  base = `http://127.0.0.1:${app.address().port}/bossmedia`;
});
after(async () => { app.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise((r) => app.close(r)), new Promise((r) => upstream.close(r))]); await require("../server").close(); await fs.rm(dir, { recursive: true, force: true }); });
async function api(path, method = "GET", data, auth = true) {
  return fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(auth ? { "X-Boss-Admin": token } : {}) }, body: data ? JSON.stringify(data) : undefined });
}
test("DASH resource tickets redirect to exact upstream resources and enforce revocation", async () => {
  const graph = require("../server").engine.graph;
  const { sealTicket } = require("../core/resource-ticket");
  const { compileTemplate } = require("../core/dash-template");
  const addon = await create("jellyfin");
  const resource = { dashTemplate: compileTemplate("seg-$Number%05d$.m4s", `${sourceUrl}/dash-test/`), headers: { Authorization: "Bearer dash-segment-key" } };
  const encoded = sealTicket(graph, addon.id, addon.id, resource, Date.now() + 60000).split("?")[0];
  const path = `/a/${addon.id}/resource/${encoded}`;
  const beforeDirect = seen.filter(entry => entry.path.startsWith("/dash-test/")).length;
  const response = await fetch(base + path + "?Number=7", { redirect: "manual" });
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), `${sourceUrl}/dash-test/seg-00007.m4s`);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(seen.filter(entry => entry.path.startsWith("/dash-test/")).length, beforeDirect);
  assert.equal(await (await fetch(response.headers.get("location"), { headers: resource.headers })).text(), "unaltered-dash-segment");
  const mpd = sealTicket(graph, addon.id, addon.id, { url: `${sourceUrl}/dash-test/show.mpd`, headers: resource.headers }, Date.now() + 60000);
  const documentResponse = await fetch(`${base}/a/${addon.id}/resource/${mpd}`, { redirect: "manual" });
  assert.equal(documentResponse.status, 307);
  assert.equal(documentResponse.headers.get("location"), `${sourceUrl}/dash-test/show.mpd`);
  assert.match(await (await fetch(documentResponse.headers.get("location"), { headers: resource.headers })).text(), /<MPD/);
  const before = seen.filter(entry => entry.path.startsWith("/dash-test/")).length;
  assert.equal((await fetch(base + path + "?Number=7&url=https://other.example")).status, 422);
  assert.equal(seen.filter(entry => entry.path.startsWith("/dash-test/")).length, before);
  graph.sql("UPDATE Sources SET revision=revision+1 WHERE id=?").run(addon.id);
  assert.equal((await fetch(base + path + "?Number=7")).status, 403);
  await api(`/api/addons/${addon.id}`, "DELETE");
});
async function create(sourceType, extra = {}) {
  const response = await api("/api/addons", "POST", { sourceType, name: "Test", baseUrl: sourceUrl, apiKey: "private-api-key", ...extra });
  const data = await response.json(); assert.equal(response.status, 201, JSON.stringify(data));
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = (await (await api("/api/addons")).json()).addons.find((item) => item.id === data.addon.id);
    if (!current.syncing) {
      assert.equal(current.sync.status, "complete", JSON.stringify(current.sync));
      assert.ok(current.jobs.every((job) => job.status === "complete"), JSON.stringify(current.jobs));
      return data.addon;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Background catalogue ingestion did not finish");
}
const local = (url) => url.replace("http://placeholder/bossmedia", base);
test("direct playback leaves upstream rate limits to the player and exposes fallback choices", async () => {
  const limited = await create("other", { baseUrl: `${sourceUrl}/limited/manifest.json` });
  const good = await create("other", { baseUrl: `${sourceUrl}/text-fallback/manifest.json` });
  let library;
  try {
    const auth = new URLSearchParams({ username: limited.xtream.username, password: limited.xtream.password });
    const [movie] = await (await fetch(`${local(limited.xtream.server)}/player_api.php?${auth}&action=get_vod_streams`)).json();
    const start = seen.length;
    const handoff = await fetch(local(movie.direct_source), { redirect: "manual" });
    assert.equal(handoff.status, 307);
    assert.match(handoff.headers.get("location"), /\/limited\/file-one$/);
    assert.equal(seen.slice(start).filter(row => row.path.startsWith("/limited/file-")).length, 0);
    const upstreamResponse = await fetch(handoff.headers.get("location"));
    assert.equal(upstreamResponse.status, 429);
    assert.equal(upstreamResponse.headers.get("retry-after"), "120");
    ({ library } = await (await api("/api/libraries", "POST", { name: "Rate limit fallback", sourceIds: [limited.id, good.id] })).json());
    const mergedAuth = new URLSearchParams({ username: library.xtream.username, password: library.xtream.password });
    const [merged] = await (await fetch(`${local(library.xtream.server)}/player_api.php?${mergedAuth}&action=get_vod_streams`)).json();
    const native = await (await fetch(local(library.bossUrl).replace(/\/addon\.boss$/, `/boss/playback/${require("../server").engine.page({ sourceIds: library.sourceIds, types: ["movie"] })[0].canonicalId}`))).json();
    assert.ok(native.resources.some(resource => resource.url.endsWith("/resolved-debrid.mp4")));
    assert.ok(native.resources.some(resource => resource.url.endsWith("/limited/file-one")));
    assert.equal(seen.slice(start).filter(row => row.path.startsWith("/limited/file-")).length, 1);
  } finally {
    if (library) await api(`/api/libraries/${library.id}`, "DELETE");
    await api(`/api/addons/${limited.id}`, "DELETE");
    await api(`/api/addons/${good.id}`, "DELETE");
  }
});
test("Boss native combined libraries return all direct choices without probing media", async () => {
  const bad = await create("other", { baseUrl: `${sourceUrl}/text-only/manifest.json` });
  const good = await create("other", { baseUrl: `${sourceUrl}/text-fallback/manifest.json` });
  const { library } = await (await api("/api/libraries", "POST", { name: "Native combined library", sourceIds: [bad.id, good.id] })).json();
  try {
    const descriptor = await (await fetch(local(library.bossUrl))).json();
    assert.equal(descriptor.format, "boss-media-addon"); assert.equal(descriptor.version, 1);
    assert.ok(library.bossUrl.endsWith("/addon.boss"));
    const legacy = await fetch(local(library.bossUrl.replace(/\.boss$/, "")));
    assert.deepEqual(await legacy.json(), descriptor);
    const download = await fetch(local(library.bossUrl), { method: "HEAD" });
    assert.match(download.headers.get("content-disposition"), /addon\.boss/);
    for (const resource of Object.values(descriptor.resources)) assert.ok(!resource.includes(".json"));
    assert.equal(descriptor.resources.guide, undefined, "Do not advertise unsupported EPG");
    const start = seen.length;
    const catalogue = await (await fetch(local(descriptor.resources.catalogue))).json();
    assert.equal(catalogue.items.length, 1, "Reliable identity deduplicates the combined library");
    const item = catalogue.items[0];
    assert.equal(item.identities.imdb, "tt0251160"); assert.equal(item.playbackState, "UNRESOLVED");
    assert.equal(seen.slice(start).filter((entry) => entry.path.includes("/stream/")).length, 0);
    const metadata = await (await fetch(local(descriptor.resources.media.replace("{id}", item.id)))).json();
    assert.equal(metadata.media.id, item.id);
    let descriptorOrigin;
    const descriptorServer = http.createServer(async (req, res) => {
      if (req.url === "/addon") return reply(res, { ...descriptor, resources: Object.fromEntries(Object.entries(descriptor.resources).map(([key, value]) => [key, value.replace("http://placeholder", descriptorOrigin)])) });
      try {
        const upstream = await fetch(`${new URL(base).origin}${req.url}`);
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(await upstream.text());
      } catch { res.writeHead(502); res.end(); }
    });
    await new Promise((resolve) => descriptorServer.listen(0, "0.0.0.0", resolve));
    descriptorOrigin = `http://127.0.0.1:${descriptorServer.address().port}`;
    try {
      const { BossClient } = await import("../public/boss-client.mjs");
      const client = await BossClient.fromAddon(`http://127.0.0.1:${descriptorServer.address().port}/addon`);
      assert.equal((await client.catalogue({ type: "movie" })).items[0].id, item.id);
      assert.equal((await client.media(item.id)).media.id, item.id);
      assert.equal((await client.playback(item.id)).resources.length, 3);
    } finally { descriptorServer.closeAllConnections(); await new Promise((resolve) => descriptorServer.close(resolve)); }
    const playback = await (await fetch(local(descriptor.resources.playback.replace("{id}", item.id)))).json();
    assert.ok(playback.resources.every(resource => resource.delivery === "direct" && resource.url.startsWith(sourceUrl)));
    assert.ok(!seen.slice(start).some(entry => entry.path === "/cached-notice" || entry.path === "/resolved-debrid.mp4"));
    const response = await fetch(playback.resources.find(resource => resource.url.endsWith("/resolved-debrid.mp4")).url);
    assert.equal(response.status, 200); assert.equal(await response.text(), "resolved-http-media");
    assert.ok(!seen.slice(start).some((entry) => entry.path === "/cached-notice"));
    const single = await (await fetch(local(bad.bossUrl))).json();
    const unavailable = await (await fetch(local(single.resources.playback.replace("{id}", item.id)))).json();
    const rejected = await fetch(local(unavailable.resources[0].url));
    assert.equal(rejected.status, 200, "The player receives the actual upstream response, not a BOSS media probe");
    assert.match(rejected.headers.get("content-type"), /text\/plain/);
    await rejected.arrayBuffer();
    assert.equal((await fetch(`${local(descriptor.resources.catalogue)}?limit=201`)).status, 400);
    await api(`/api/libraries/${library.id}`, "DELETE");
    assert.equal((await fetch(local(library.bossUrl))).status, 404);
  } finally {
    await api(`/api/addons/${bad.id}`, "DELETE"); await api(`/api/addons/${good.id}`, "DELETE");
  }
});
test("search-only sources discover paginated canonical metadata without resolving playback", async () => {
  const source = await create("other", { baseUrl: `${sourceUrl}/search-only/manifest.json` });
  const broken = await create("other", { baseUrl: `${sourceUrl}/search-broken/manifest.json` });
  const response = await api("/api/libraries", "POST", { name: "Search library", sourceIds: [source.id, broken.id] });
  const { library } = await response.json();
  try {
    const root = `/a/${library.id}/catalog/movie/boss-movie`;
    assert.deepEqual((await (await api(`${root}.json`)).json()).metas, []);
    const start = seen.length;
    const search = async (offset) => (await (await api(`${root}/search=Discovery&skip=${offset}.json`)).json()).metas;
    const first = await search(0);
    assert.equal(first.length, 100);
    assert.deepEqual(await search(0), first, "repeat searches retain canonical IDs");
    const second = await search(100);
    const third = await search(200);
    assert.equal(new Set([...first, ...second, ...third].map((item) => item.id)).size, 300);
    assert.equal(seen.slice(start).filter((entry) => entry.path.includes("/stream/")).length, 0);
    const auth = new URLSearchParams({ username: library.xtream.username, password: library.xtream.password });
    const movies = await (await fetch(`${local(library.xtream.server)}/player_api.php?${auth}&action=get_vod_streams`)).json();
    assert.equal(movies.length, 300, "discovered metadata is shared with other output adapters");
    assert.equal(await (await fetch(local(movies[0].direct_source))).text(), "resolved-http-media");
    const { BossClient } = await import("../public/boss-client.mjs");
    const client = await BossClient.fromXtream(local(library.xtream.server), library.xtream.username, library.xtream.password);
    const categories = await client.categories({ type: "movie", limit: 200 });
    const nativeCategories = await (await api(`/a/${library.id}/boss/categories?type=movie&limit=200`)).json();
    assert.deepEqual(categories, nativeCategories);
    assert.ok(categories.categories.length > 0);
    const categoryPage = await client.catalogue({ type: "movie", categoryId: categories.categories[0].id, limit: 1 });
    const nativeCategoryPage = await (await api(`/a/${library.id}/boss/catalogue?type=movie&categoryId=${categories.categories[0].id}&limit=1`)).json();
    assert.deepEqual(categoryPage, nativeCategoryPage);
    assert.equal((await api(`/a/${library.id}/boss/categories?type=movie&limit=201`)).status, 400);
    const nativePage = await client.search("Discovery", { type: "movie", skip: 200, limit: 100 });
    assert.equal(nativePage.items.length, 100); assert.equal(nativePage.nextOffset, 300);
    const nativeItem = nativePage.items[0];
    assert.ok(movies.some((movie) => movie.stream_id === nativeItem.xtreamId));
    const resolved = await client.playback(nativeItem.id);
    assert.equal(await (await fetch(local(resolved.resources[0].url))).text(), "resolved-http-media");
    await assert.rejects(BossClient.fromXtream(local(library.xtream.server), library.xtream.username, "wrong"), (error) => error.status === 401);
    const docs = await api("/sdk", "GET", undefined, false);
    assert.equal(docs.status, 200); assert.match(await docs.text(), /Player acceptance checklist/);
    assert.equal((await api("/sdk/client.mjs", "GET", undefined, false)).status, 200);
  } finally {
    await api(`/api/libraries/${library.id}`, "DELETE");
    await api(`/api/addons/${source.id}`, "DELETE");
    await api(`/api/addons/${broken.id}`, "DELETE");
  }
});
test("direct handoff never probes upstream playback or reingests metadata", async () => {
  for (const kind of ["renewal", "unavailable"]) {
    const addon = await create("other", { baseUrl: `${sourceUrl}/${kind}/manifest.json` });
    try {
      const auth = new URLSearchParams({ username: addon.xtream.username, password: addon.xtream.password });
      const [movie] = await (await fetch(`${local(addon.xtream.server)}/player_api.php?${auth}&action=get_vod_streams`)).json();
      const start = seen.length;
      const first = await fetch(local(movie.direct_source), { redirect: "manual" });
      assert.equal(first.status, 307);
      assert.equal(first.headers.get("location"), `${sourceUrl}/${kind === "renewal" ? "renewal-1.mp4" : "unavailable.mp4"}`);
      renewalVersion = 2;
      const second = await fetch(local(movie.direct_source), { redirect: "manual" });
      assert.equal(second.status, 307);
      assert.equal(second.headers.get("location"), first.headers.get("location"), "Cached resolutions are not invalidated without player failure feedback");
      assert.equal(seen.slice(start).filter((entry) => entry.path.startsWith(`/${kind}/stream/`)).length, 1);
      assert.equal(seen.slice(start).filter((entry) => entry.path.endsWith(".mp4")).length, 0);
      assert.equal(seen.slice(start).filter((entry) => entry.path.includes("/catalog/")).length, 0);
    } finally { await api(`/api/addons/${addon.id}`, "DELETE"); }
  }
});
test("management requires authentication", async () => { assert.equal((await api("/api/addons", "GET", null, false)).status, 401); });
for (const type of ["jellyfin", "emby"]) test(`${type}: SDK catalog, series metadata, direct playback headers, encrypted storage and revocation`, async () => {
  const addon = await create(type);
  const root = `/a/${addon.id}`;
  const manifest = await (await api(`${root}/manifest.json`)).json(); assert.ok(manifest.id);
  const catalog = await (await api(`${root}/catalog/movie/boss-movie/search=Test&skip=0.json`)).json(); assert.equal(catalog.metas.length, 1);
  const item = catalog.metas[0]; assert.ok(!JSON.stringify(item).includes("private-api-key"));
  const streams = await (await api(`${root}/stream/movie/${encodeURIComponent(item.id)}.json`)).json(); assert.equal(streams.streams.length, 1);
  assert.equal(streams.streams[0].url.startsWith(sourceUrl), true);
  const playbackHeaders = { ...streams.streams[0].behaviorHints.proxyHeaders.request, Range: "bytes=0-3" };
  const playback = await fetch(streams.streams[0].url, { headers: playbackHeaders }); assert.equal(playback.status, 206); assert.equal(await playback.text(), "test");
  const series = await (await api(`${root}/catalog/series/boss-series.json`)).json();
  const meta = await (await api(`${root}/meta/series/${encodeURIComponent(series.metas[0].id)}.json`)).json(); assert.equal(meta.meta.videos[0].episode, 2);
  const storage = (await fs.readFile(`${dir}/boss.db`)).toString() + (await fs.readFile(`${dir}/boss.db-wal`)).toString(); assert.ok(!storage.includes("private-api-key")); assert.ok(!storage.includes(sourceUrl));
  assert.equal((await api(`${root}/media/${Buffer.from("http://169.254.169.254/").toString("base64url")}`)).status, 404);
  await api(`/api/addons/${addon.id}`, "DELETE"); assert.equal((await api(`${root}/manifest.json`)).status, 404);
});
test("other sources preserve catalogs, metadata and playback with scoped IDs", async () => {
  const addon = await create("other", { baseUrl: `${sourceUrl}/remote/manifest.json` });
  const root = `/a/${addon.id}`;
  const data = await (await api(`${root}/catalog/movie/boss-movie/search=Remote&skip=0.json`)).json();
  const itemId = encodeURIComponent(data.metas[0].id);
  const poster = await fetch(local(data.metas[0].poster));
  assert.equal(poster.status, 200); assert.equal(poster.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await poster.arrayBuffer()).subarray(1, 4).toString(), "PNG");
  const meta = await (await api(`${root}/meta/movie/${itemId}.json`)).json(); assert.equal(meta.meta.id, data.metas[0].id); assert.match(meta.meta.id, /^boss:[a-f0-9-]{36}$/);
  const streams = await (await api(`${root}/stream/movie/${itemId}.json`)).json(); assert.equal(streams.streams.length, 1);
  assert.equal(await (await fetch(local(streams.streams[0].url))).text(), "resolved-http-media");
});
test("WebDAV handles arbitrary XML namespaces, escaped filenames and rejects forged targets", async () => {
  const addon = await create("webdav", { baseUrl: sourceUrl, libraryPath: "/dav", username: "user", password: "pass" });
  const root = `/a/${addon.id}`;
  const data = await (await api(`${root}/catalog/movie/boss-movie.json`)).json(); assert.equal(data.metas[0].name, "Movie & One");
  const streams = await (await api(`${root}/stream/movie/${encodeURIComponent(data.metas[0].id)}.json`)).json();
  assert.equal(streams.streams[0].url, `${sourceUrl}/dav/Movie%20%26%20One.mp4`);
  const media = await fetch(streams.streams[0].url, { headers: streams.streams[0].behaviorHints.proxyHeaders.request }); assert.equal(await media.text(), "dav-media");
  assert.equal((await api(`${root}/media/${Buffer.from("http://evil.example/").toString("base64url")}`)).status, 404);
});
test("concurrent creates persist without lost updates", async () => {
  const before = (await (await api("/api/addons")).json()).addons.length;
  await Promise.all([create("emby"), create("emby"), create("emby")]);
  assert.equal((await (await api("/api/addons")).json()).addons.length, before + 3);
});
for (const type of ["jellyfin", "emby", "plex", "webdav", "other", "xtream", "m3u"]) test(`${type} converts to Boss, Xtream and M3U`, async () => {
  const extra = type === "xtream" ? { username: "source-user", password: "source-password" } : type === "m3u" ? { baseUrl: `${sourceUrl}/playlist.m3u` } : type === "other" ? { baseUrl: `${sourceUrl}/remote/manifest.json` } : type === "webdav" ? { libraryPath: "/dav", username: "user", password: "pass" } : {};
  const addon = await create(type, extra);
  if (["jellyfin", "emby", "plex", "xtream"].includes(type)) {
    const listing = await (await fetch(local(addon.playlistUrl))).text();
    assert.match(listing, /\/series\//, "episodes are indexed before any series detail request");
  }
  const manifest = await (await fetch(local(addon.installUrl))).json(); assert.ok(manifest.catalogs.length);
  const auth = new URLSearchParams({ username: addon.xtream.username, password: addon.xtream.password });
  const xtream = `${local(addon.xtream.server)}/player_api.php?${auth}`;
  assert.equal((await (await fetch(xtream)).json()).user_info.auth, 1);
  assert.equal((await fetch(`${local(addon.xtream.server)}/player_api.php?username=${addon.id}&password=wrong`)).status, 401);
  const movies = await (await fetch(`${xtream}&action=get_vod_streams`)).json(); assert.ok(movies.length);
  assert.ok(Number.isSafeInteger(movies[0].stream_id));
  const playback = await fetch(local(movies[0].direct_source), { redirect: "manual" }); assert.equal(playback.status, 307);
  assert.ok(playback.headers.get("location").startsWith(sourceUrl));
  assert.equal((await playback.arrayBuffer()).byteLength, 0);
  const playlist = await (await fetch(local(addon.playlistUrl))).text(); assert.ok(playlist.startsWith("#EXTM3U")); assert.ok(!playlist.includes("source-password")); assert.ok(!playlist.includes("magnet:"));
  if (type === "xtream") {
    const alternateRoute = await fetch(local(movies[0].direct_source).replace(/\.mp4$/, ".mkv"), { redirect: "manual" });
    assert.equal(alternateRoute.status, 307);
    assert.match(alternateRoute.headers.get("location"), /\/movie\/source-user\/source-password\/2\.mp4$/, "Output route suffixes never alter the upstream container path");
    const series = await (await fetch(`${xtream}&action=get_series`)).json();
    const info = await (await fetch(`${xtream}&action=get_series_info&series_id=${series[0].series_id}`)).json();
    const episode = info.episodes["1"][0];
    const episodeHandoff = await fetch(local(episode.direct_source), { redirect: "manual" });
    assert.equal(episodeHandoff.status, 307);
    assert.match(episodeHandoff.headers.get("location"), /\/series\/source-user\/source-password\/4\.mp4$/);
  }
  await api(`/api/addons/${addon.id}`, "DELETE");
  assert.equal((await fetch(xtream)).status, 404);
});
test("torrent policy permits resolved debrid HTTP and rejects torrent mechanisms", () => {
  const { allowedStreams, httpMedia } = require("../stream-policy");
  assert.equal(httpMedia("https://debrid.example.com/resolved/video.mp4"), true);
  for (const url of ["magnet:?xt=urn:btih:abc", "https://host/file.torrent", "https://host/file%2Etorrent?download=1", "ftp://host/file.mp4", "https://host/?url=magnet%3Aabc"]) assert.equal(httpMedia(url), false);
  assert.equal(allowedStreams([{ url: "https://host/video.mp4", infoHash: "hash" }, { url: "https://host/video.mp4", sources: [] }, { url: "https://debrid.example.com/resolved/video.mp4" }]).length, 1);
});
test("HLS playlists and relative resources remain exact upstream links", async () => {
  const addon = await create("other", { baseUrl: `${sourceUrl}/hls/manifest.json` });
  const catalog = await (await api(`/a/${addon.id}/catalog/movie/boss-movie.json`)).json();
  const streams = await (await api(`/a/${addon.id}/stream/movie/${encodeURIComponent(catalog.metas[0].id)}.json`)).json();
  assert.equal(streams.streams[0].url, `${sourceUrl}/stream.m3u8`);
  const playlist = await (await fetch(streams.streams[0].url)).text();
  const segment = playlist.split("\n").find((line) => line && !line.startsWith("#"));
  assert.equal(segment, "segment.ts");
  assert.equal(await (await fetch(new URL(segment, streams.streams[0].url))).text(), "hls-segment");
});

test("virtual Xtream library resolves canonical identity through an authorized metadata-free source only on play", async () => {
  const start = seen.length;
  const catalogue = await create("catalogue", { baseUrl: `${sourceUrl}/identity/manifest.json` });
  assert.equal(catalogue.capabilities.streams, false);
  const duplicate = await create("other", { baseUrl: `${sourceUrl}/identity/manifest.json` });
  const resolver = await create("other", { baseUrl: `${sourceUrl}/resolver/manifest.json` });
  const response = await api("/api/libraries", "POST", { name: "Unified library", sourceIds: [catalogue.id, duplicate.id, resolver.id] });
  assert.equal(response.status, 201);
  const { library } = await response.json();
  const auth = new URLSearchParams({ username: library.xtream.username, password: library.xtream.password });
  const endpoint = `${local(library.xtream.server)}/player_api.php?${auth}`;
  const rows = await (await fetch(`${endpoint}&action=get_vod_streams`)).json();
  assert.equal(rows.length, 1, "reliable IMDb identity deduplicates across sources");
  assert.equal(rows[0].name, "Inception");
  assert.equal(seen.slice(start).filter((entry) => /\/(identity|resolver)\/stream\//.test(entry.path)).length, 0);
  const output = await (await fetch(local(library.installUrl).replace("manifest.json", "catalog/movie/boss-movie.json"))).json();
  assert.equal(output.metas.length, 1);
  assert.equal(await (await fetch(local(rows[0].direct_source))).text(), "resolved-http-media");
  assert.ok(seen.some((entry) => entry.path === "/resolver/stream/movie/tt1375666.json"));
  const metadataOnlyLibrary = await (await api("/api/libraries", "POST", { name: "Catalogue and resolver", sourceIds: [catalogue.id, resolver.id] })).json();
  const catalogueStart = seen.length;
  const native = await (await fetch(local(metadataOnlyLibrary.library.bossUrl))).json();
  const nativePage = await (await fetch(local(native.resources.catalogue))).json();
  assert.equal(nativePage.items[0].title, "Inception");
  const playlist = await (await fetch(local(metadataOnlyLibrary.library.playlistUrl))).text();
  assert.ok(playlist.includes("Inception"));
  const metadataAuth = new URLSearchParams({ username: metadataOnlyLibrary.library.xtream.username, password: metadataOnlyLibrary.library.xtream.password, action: "get_vod_streams" });
  const [metadataRow] = await (await fetch(`${local(metadataOnlyLibrary.library.xtream.server)}/player_api.php?${metadataAuth}`)).json();
  assert.equal(await (await fetch(local(metadataRow.direct_source))).text(), "resolved-http-media");
  assert.equal(seen.slice(catalogueStart).filter((entry) => /\/identity\/stream\//.test(entry.path)).length, 0);
  await api(`/api/addons/${resolver.id}`, "DELETE");
  assert.equal((await fetch(local(rows[0].direct_source))).status, 422, "cached streams cannot bypass source revocation");
});

for (const type of ["m3u", "xtream", "boss"]) test(`${type} XMLTV ingestion maps real guide entries to persistent output channel IDs`, async () => {
  const addon = await create(type, { baseUrl: type === "boss" ? `${sourceUrl}/boss-live/addon` : type === "m3u" ? `${sourceUrl}/live.m3u` : sourceUrl, username: "source-user", password: "source-password", xmltvUrl: `${sourceUrl}/guide.xml` });
  const auth = new URLSearchParams({ username: addon.id, password: addon.xtream.password });
  const endpoint = `${local(addon.xtream.server)}/player_api.php?${auth}`;
  const [channel] = await (await fetch(`${endpoint}&action=get_live_streams`)).json();
  assert.equal(channel.epg_channel_id, String(channel.stream_id));
  assert.equal(channel.tv_archive, 0, "no unsupported archive capability is advertised");
  const descriptor = await (await fetch(local(addon.bossUrl))).json();
  assert.equal(descriptor.capabilities.epg, true);
  assert.equal(descriptor.capabilities.catchup, false);
  const page = await (await fetch(`${local(descriptor.resources.catalogue)}?type=channel`)).json();
  assert.equal(page.items[0].channel.epgId, channel.epg_channel_id);
  if (type === "boss") assert.equal(page.items[0].channel.number, "42");
  const guide = await (await fetch(`${local(addon.xtream.server)}/xmltv.php?${auth}`)).text();
  assert.ok(guide.includes(`<programme channel="${channel.stream_id}"`));
  assert.ok(guide.includes("News &amp; Weather"));
  assert.ok(!guide.includes("Outside library"));
  const { epg_listings: events } = await (await fetch(`${endpoint}&action=get_short_epg&stream_id=${channel.stream_id}`)).json();
  assert.equal(events.length, 1);
  assert.equal(Buffer.from(events[0].title, "base64").toString(), "News & Weather");
  assert.equal(Number(events[0].start_timestamp), guideStart / 1000);
  await api(`/api/addons/${addon.id}`, "DELETE");
});

test("EPG sync failures are persisted and visible without leaking upstream URLs", async () => {
  const response = await api("/api/addons", "POST", { sourceType: "m3u", name: "Broken guide", baseUrl: `${sourceUrl}/live.m3u`, xmltvUrl: `${sourceUrl}/bad-guide.xml` });
  const { addon } = await response.json();
  assert.equal(response.status, 201);
  let current;
  for (let attempt = 0; attempt < 200; attempt++) {
    current = (await (await api("/api/addons")).json()).addons.find((source) => source.id === addon.id);
    if (!current.syncing) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(current.sync.status, "failed"); assert.equal(current.sync.phase, "epg");
  assert.equal(current.sync.error_code, "SYNC_FAILED");
  assert.ok(!JSON.stringify(current).includes(sourceUrl));
  await api(`/api/addons/${addon.id}`, "DELETE");
});

test("source-supported archives resolve through the canonical graph with separate interval caches", async () => {
  const addon = await create("xtream", { username: "source-user", password: "source-password", enableCatchup: true });
  const auth = new URLSearchParams({ username: addon.id, password: addon.xtream.password });
  const endpoint = `${local(addon.xtream.server)}/player_api.php?${auth}`;
  const [channel] = await (await fetch(`${endpoint}&action=get_live_streams`)).json();
  assert.equal(channel.tv_archive, 1); assert.equal(channel.tv_archive_duration, 2);
  const playlist = await (await fetch(local(addon.playlistUrl))).text();
  assert.match(playlist, /catchup="xc" catchup-days="2"/);
  const makeUrl = (start) => `${local(addon.xtream.server)}/timeshift/${addon.id}/${addon.xtream.password}/30/${new Date(start).toISOString().slice(0, 16).replace("T", ":").replace(/:(\d{2})$/, "-$1")}/${channel.stream_id}.ts`;
  const first = guideStart - 10800000, second = first - 3600000;
  for (const start of [first, second]) assert.equal(await (await fetch(makeUrl(start))).text(), "archive-media");
  const requests = seen.filter((entry) => entry.path.startsWith("/timeshift/"));
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].path, requests[1].path, "different intervals cannot share cached resolutions");
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(clock.formatToParts(new Date(first)).map((part) => [part.type, part.value]));
  assert.ok(requests[0].path.includes(`${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`));
  assert.equal((await fetch(makeUrl(guideStart - 3 * 86400000))).status, 422);
  assert.equal((await fetch(makeUrl(guideStart + 86400000))).status, 400);
  assert.equal(seen.filter((entry) => entry.path.startsWith("/timeshift/")).length, 2);
  const descriptor = await (await fetch(local(addon.bossUrl))).json();
  const page = await (await fetch(`${local(descriptor.resources.catalogue)}?type=channel`)).json();
  const id = page.items[0].id;
  assert.equal(page.items[0].channel.catchupDays, 2);
  const interval = { start: first, end: first + 1800000 };
  const archiveUrl = `${local(descriptor.resources.catchup.replace("{id}", id))}?${new URLSearchParams(interval)}`;
  const nativeArchive = await (await fetch(archiveUrl)).json();
  assert.equal(seen.filter((entry) => entry.path.startsWith("/timeshift/")).length, 2, "Native resource lookup does not download archive media");
  assert.equal(await (await fetch(local(nativeArchive.resources[0].url))).text(), "archive-media");
  const { BossClient } = await import("../public/boss-client.mjs");
  const client = await BossClient.fromXtream(local(addon.xtream.server), addon.xtream.username, addon.xtream.password);
  const sdkArchive = await client.catchup(id, interval);
  assert.equal(sdkArchive.resources[0].url, nativeArchive.resources[0].url);
  await assert.rejects(client.catchup(id, { start: first }), (error) => error.status === 400);
  assert.equal((await fetch(archiveUrl.replace(`end=${interval.end}`, `end=${first - 1}`))).status, 400);
  await api(`/api/addons/${addon.id}`, "DELETE");
});

test("library edits preserve install URLs and revoke future resolution without controlling handed-off URLs", async () => {
  const hls = await create("other", { baseUrl: `${sourceUrl}/hls/manifest.json` });
  const other = await create("other", { baseUrl: `${sourceUrl}/remote/manifest.json` });
  const { library } = await (await api("/api/libraries", "POST", { name: "Editable", sourceIds: [hls.id, other.id] })).json();
  const root = `/a/${library.id}`;
  const own = await (await api(`/a/${hls.id}/catalog/movie/boss-movie.json`)).json();
  const item = own.metas[0];
  const getStreams = async () => (await (await api(`${root}/stream/movie/${encodeURIComponent(item.id)}.json`)).json()).streams;
  const [direct] = await getStreams();
  assert.equal(direct.url, `${sourceUrl}/stream.m3u8`);
  assert.match(await (await fetch(direct.url)).text(), /segment\.ts/);
  const change = { name: "Edited", sourceIds: [other.id], revision: library.revision };
  assert.equal((await api(`/api/libraries/${library.id}`, "POST", change, false)).status, 401);
  const update = await api(`/api/libraries/${library.id}`, "POST", change);
  assert.equal(update.status, 200);
  const { library: edited } = await update.json();
  assert.equal(edited.installUrl, library.installUrl); assert.deepEqual(edited.xtream, library.xtream);
  assert.equal((await fetch(direct.url)).status, 200, "BOSS cannot revoke a provider URL already handed to a player");
  assert.equal((await api(`${root}/stream/movie/${encodeURIComponent(item.id)}.json`)).status, 404, "Removed source mappings cannot be resolved again");
  assert.equal((await api(`/api/libraries/${library.id}`, "POST", change)).status, 409);
  assert.equal((await api(`/api/libraries/${library.id}`, "POST", { ...change, sourceIds: ["missing"], revision: edited.revision })).status, 400);
  assert.equal((await api(`/api/libraries/${library.id}`, "POST", { name: "Restored", sourceIds: [hls.id, other.id], revision: edited.revision })).status, 200);
  assert.ok((await getStreams()).some(stream => stream.url === direct.url), "Re-adding the source restores it to fresh resolution");
  await api(`/api/libraries/${library.id}`, "DELETE");
  await api(`/api/addons/${hls.id}`, "DELETE"); await api(`/api/addons/${other.id}`, "DELETE");
});

test("library playback profiles filter codecs, resolution and HDR through HTTP outputs", async () => {
  const source = await create("other", { baseUrl: `${sourceUrl}/profiles/manifest.json` });
  const profile = { codecs: ["h264"], maxHeight: 720, language: "en", hdr: false, strictCapabilities: true };
  const { library } = await (await api("/api/libraries", "POST", { name: "Restricted player", sourceIds: [source.id], profile })).json();
  const auth = new URLSearchParams({ username: library.id, password: library.xtream.password });
  const endpoint = `${local(library.xtream.server)}/player_api.php?${auth}&action=get_vod_streams`;
  const [movie] = await (await fetch(endpoint)).json();
  assert.equal(await (await fetch(local(movie.direct_source))).text(), "/quality-h264.mp4");
  const edit = await api(`/api/libraries/${library.id}`, "POST", { name: library.name, sourceIds: library.sourceIds, revision: library.revision, profile: { codecs: ["hevc"], maxHeight: 2160, language: "fr", hdr: true, strictCapabilities: true } });
  assert.equal(edit.status, 200);
  const { library: updated } = await edit.json();
  assert.equal(await (await fetch(local(movie.direct_source))).text(), "/quality-hevc.mp4", "old output URL must use the current playback policy");
  assert.equal((await (await fetch(endpoint)).json())[0].stream_id, movie.stream_id);
  assert.equal((await api(`/api/libraries/${library.id}`, "POST", { name: library.name, sourceIds: library.sourceIds, revision: updated.revision, profile: { codecs: ["hevc"], hdr: false, strictCapabilities: true } })).status, 200);
  assert.equal((await fetch(local(movie.direct_source))).status, 422, "HDR must not be delivered to an SDR-only profile");
  assert.equal((await api("/api/libraries", "POST", { name: "Invalid", sourceIds: [source.id], profile: { codecs: ["made-up"] } })).status, 400);
  await api(`/api/libraries/${library.id}`, "DELETE"); await api(`/api/addons/${source.id}`, "DELETE");
});

test("native, Xtream and M3U SDK playback enforce advertised player capabilities identically", async () => {
  const { BossClient } = await import("../public/boss-client.mjs");
  const source = await create("other", { baseUrl: `${sourceUrl}/profiles/manifest.json` });
  let library, descriptorServer;
  try {
    ({ library } = await (await api("/api/libraries", "POST", { name: "Capability fixture", sourceIds: [source.id] })).json());
    const descriptor = await (await fetch(local(library.bossUrl))).json();
    assert.equal(descriptor.playbackCapabilities.version, 1);
    const { items: [item] } = await (await fetch(local(descriptor.resources.catalogue))).json();
    let origin;
    // The existing HTTP fixture advertises a placeholder public origin. This
    // shim replaces only discovery URLs; all resource calls reach real routes.
    descriptorServer = http.createServer(async (req, res) => {
      try {
        if (req.url === "/addon.boss") return reply(res, { ...descriptor, resources: Object.fromEntries(Object.entries(descriptor.resources).map(([key, value]) => [key, value.replace("http://placeholder", origin)])) });
        if (req.url === "/playlist.m3u") {
          const playlist = await (await fetch(`${base}/a/${library.id}/playlist.m3u`)).text();
          res.setHeader("Content-Type", "audio/x-mpegurl");
          return res.end(playlist.replace(library.bossUrl, `${origin}/addon.boss`));
        }
        const response = await fetch(`${new URL(base).origin}${req.url}`);
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(await response.text());
      } catch { res.writeHead(502); res.end(); }
    });
    await new Promise(resolve => descriptorServer.listen(0, "0.0.0.0", resolve));
    origin = `http://127.0.0.1:${descriptorServer.address().port}`;
    const clients = [await BossClient.fromAddon(`${origin}/addon.boss`),
      await BossClient.fromXtream(local(library.xtream.server), library.xtream.username, library.xtream.password),
      await BossClient.fromM3u(`${origin}/playlist.m3u`)];
    const capabilities = { codecs: ["h264"], maxHeight: 1080, hdr: false, strictCapabilities: true, language: "en" };
    let retainedURL;
    for (const client of clients) {
      const before = seen.filter(entry => entry.path.startsWith("/quality-")).length;
      const response = await client.playback(item.id, { capabilities });
      assert.equal(seen.filter(entry => entry.path.startsWith("/quality-")).length, before, "Playback lookup may resolve links but must not download media");
      assert.equal(response.resources.length, 1);
      assert.equal(response.resources[0].codec, "h264");
      assert.deepEqual(response.resources[0].resolution, { width: 1280, height: 720, inferred: true });
      const url = new URL(response.resources[0].url);
      assert.equal(url.href, `${sourceUrl}/quality-h264.mp4`, "Provider URLs are not modified with BOSS query parameters");
      const playback = await fetch(local(url.href));
      assert.equal(playback.status, 200);
      assert.equal(await playback.text(), "/quality-h264.mp4", "Must select the original H264 resource without conversion");
      assert.equal(response.resources[0].headerOrigin, sourceUrl);
      retainedURL = url.href;
    }
    const auth = new URLSearchParams({ username: library.xtream.username, password: library.xtream.password });
    const [vod] = await (await fetch(`${local(library.xtream.server)}/player_api.php?${auth}&action=get_vod_streams`)).json();
    const direct = new URL(local(vod.direct_source)); direct.searchParams.set("boss_codecs", "h264"); direct.searchParams.set("boss_hdr", "false");
    assert.equal(await (await fetch(direct)).text(), "/quality-h264.mp4");
    assert.equal(await (await fetch(local(vod.direct_source), { method: "POST", body: new URLSearchParams({ boss_codecs: "h264", boss_hdr: "false" }) })).text(), "/quality-h264.mp4");
    direct.searchParams.append("boss_hdr", "true");
    assert.equal((await fetch(direct)).status, 400);
    for (const client of clients) await assert.rejects(client.playback(item.id, { capabilities: { ...capabilities, maxHeight: 480 } }), { status: 422 });
    const duplicate = new URLSearchParams({ ...Object.fromEntries(auth), action: "playback", id: item.id, boss_hdr: "false" });
    duplicate.append("boss_hdr", "true");
    assert.equal((await fetch(`${local(library.xtream.server)}/boss_api`, { method: "POST", body: duplicate })).status, 400);
    duplicate.delete("boss_hdr"); duplicate.set("boss_hdr", "false");
    assert.equal((await fetch(`${local(library.xtream.server)}/boss_api?boss_hdr=true`, { method: "POST", body: duplicate })).status, 400);
    const edit = await api(`/api/libraries/${library.id}`, "POST", { name: library.name, sourceIds: library.sourceIds, revision: library.revision, profile: { codecs: ["hevc"], hdr: true } });
    assert.equal(edit.status, 200);
    assert.equal((await fetch(local(retainedURL))).status, 200, "BOSS cannot revoke a provider URL already handed to a player");
    for (const client of clients) await assert.rejects(client.playback(item.id, { capabilities }), { status: 422 });
  } finally {
    if (descriptorServer) { descriptorServer.closeAllConnections(); await new Promise(resolve => descriptorServer.close(resolve)); }
    if (library) await api(`/api/libraries/${library.id}`, "DELETE");
    await api(`/api/addons/${source.id}`, "DELETE");
  }
});

test("source editing preserves IDs and credentials, invalidates caches and rejects unsafe origin changes", async () => {
  const addon = await create("emby");
  const endpoint = `/api/addons/${addon.id}`;
  const details = await (await api(endpoint)).json();
  assert.ok(!JSON.stringify(details).includes("private-api-key"));
  assert.equal(details.source.configuration.apiKey, undefined);
  const auth = new URLSearchParams({ username: addon.id, password: addon.xtream.password });
  const url = `${local(addon.xtream.server)}/player_api.php?${auth}&action=get_vod_streams`;
  const [before] = await (await fetch(url)).json();
  assert.equal((await fetch(local(before.direct_source), { redirect: "manual" })).status, 307);
  assert.equal((await api(endpoint, "POST", { revision: details.source.revision, name: "Unauthorized" }, false)).status, 401);
  assert.equal((await api(endpoint, "POST", { revision: details.source.revision, baseUrl: "https://different.example" })).status, 400);
  assert.equal((await api(endpoint, "POST", { revision: details.source.revision, baseUrl: "https://different.example", replaceCredentials: true })).status, 400, "explicit replacement cannot reuse an omitted secret");
  assert.equal((await api(endpoint, "POST", { revision: details.source.revision, baseUrl: "not a URL" })).status, 400);
  const probe = await api(`${endpoint}/probe`, "POST", { revision: details.source.revision, name: "Draft", apiKey: "" });
  assert.equal(probe.status, 200);
  assert.equal((await (await api(endpoint)).json()).source.name, "Test", "probing a draft must not persist it");
  const change = await api(endpoint, "POST", { revision: details.source.revision, name: "Updated source", apiKey: "new-private-key" });
  assert.equal(change.status, 200);
  const { addon: updated } = await change.json();
  assert.equal(updated.installUrl, addon.installUrl); assert.deepEqual(updated.xtream, addon.xtream);
  assert.equal((await api(endpoint, "POST", { revision: details.source.revision, name: "Stale edit" })).status, 409);
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = (await (await api("/api/addons")).json()).addons.find((source) => source.id === addon.id);
    if (!current.syncing) { assert.equal(current.sync.status, "complete"); break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await (await fetch(url)).json())[0].stream_id, before.stream_id);
  const catalog = await (await api(`/a/${addon.id}/catalog/movie/boss-movie.json`)).json();
  const resolved = await (await api(`/a/${addon.id}/stream/movie/${encodeURIComponent(catalog.metas[0].id)}.json`)).json();
  assert.equal(resolved.streams[0].behaviorHints.proxyHeaders.request["X-Emby-Token"], "new-private-key");
  assert.equal(await (await fetch(resolved.streams[0].url, { headers: resolved.streams[0].behaviorHints.proxyHeaders.request })).text(), "test-video");
  const fresh = (await (await api(endpoint)).json()).source;
  assert.ok(!JSON.stringify(fresh).includes("new-private-key"));
  assert.equal((await api(`${endpoint}/probe`, "POST", { revision: fresh.revision, apiKey: "" })).status, 200, "blank secret fields preserve the saved credential");
  await api(endpoint, "DELETE");
});

for (const protocol of ["jellyfin", "emby", "boss"]) test(`${protocol} external subtitles preserve direct URLs and required headers`, async () => {
  const addon = await create(protocol, protocol === "boss" ? { baseUrl: `${sourceUrl}/boss-captions/addon` } : {});
  const root = `/a/${addon.id}`;
  const manifest = await (await api(`${root}/manifest.json`)).json();
  assert.ok(manifest.resources.includes("subtitles"));
  const { metas } = await (await api(`${root}/catalog/movie/boss-movie.json`)).json();
  const { subtitles } = await (await api(`${root}/subtitles/movie/${encodeURIComponent(metas[0].id)}.json`)).json();
  assert.equal(subtitles.length, 1, "bitmap subtitles must not be mislabeled as text");
  assert.equal(subtitles[0].lang, "eng");
  assert.ok(subtitles[0].url.startsWith(sourceUrl));
  assert.equal(subtitles[0].delivery, "direct");
  const resource = await fetch(subtitles[0].url, { headers: subtitles[0].requiredHeaders });
  assert.equal(resource.status, 200); assert.match(await resource.text(), /Authorized subtitle/);
  if (protocol === "boss") {
    const descriptor = await (await fetch(local(addon.bossUrl))).json();
    const page = await (await fetch(local(descriptor.resources.catalogue))).json();
    const native = await (await fetch(local(descriptor.resources.subtitles.replace("{id}", page.items[0].id)))).json();
    assert.equal(native.subtitles.length, 1);
    assert.equal(native.subtitles[0].delivery, "direct");
    assert.equal(native.subtitles[0].headerOrigin, sourceUrl);
    assert.match(await (await fetch(native.subtitles[0].url, { headers: native.subtitles[0].requiredHeaders })).text(), /Authorized subtitle/);
    assert.ok(!seen.some((entry) => entry.path === "/expired-caption" || entry.path === "/blocked.torrent"));
  }
  await api(`/api/addons/${addon.id}`, "DELETE");
  assert.equal((await fetch(subtitles[0].url, { headers: subtitles[0].requiredHeaders })).status, 200, "BOSS cannot revoke an upstream subtitle URL already handed off");
});

test("subtitle lookup isolates failed sources and filters torrent resources", async () => {
  const broken = await create("other", { baseUrl: `${sourceUrl}/broken-captions/manifest.json` });
  const working = await create("other", { baseUrl: `${sourceUrl}/captions/manifest.json` });
  const { library } = await (await api("/api/libraries", "POST", { name: "Captions", sourceIds: [broken.id, working.id] })).json();
  const root = `/a/${library.id}`;
  const { metas } = await (await api(`${root}/catalog/movie/boss-movie.json`)).json();
  const { subtitles } = await (await api(`${root}/subtitles/movie/${encodeURIComponent(metas[0].id)}.json`)).json();
  assert.equal(subtitles.length, 1);
  assert.match(await (await fetch(subtitles[0].url, { headers: subtitles[0].requiredHeaders })).text(), /Authorized subtitle/);
  await api(`/api/libraries/${library.id}`, "POST", { name: "Removed caption source", sourceIds: [broken.id], revision: library.revision });
  assert.equal((await fetch(subtitles[0].url, { headers: subtitles[0].requiredHeaders })).status, 200);
  assert.deepEqual((await (await api(`${root}/subtitles/movie/${encodeURIComponent(metas[0].id)}.json`)).json()).subtitles, []);
  await api(`/api/libraries/${library.id}`, "DELETE");
  await api(`/api/addons/${broken.id}`, "DELETE"); await api(`/api/addons/${working.id}`, "DELETE");
});

test("HTTP playback IDs survive server and database reopen without replaying catalogue ingestion", async () => {
  const addon = await create("other", { baseUrl: `${sourceUrl}/remote/manifest.json` });
  const auth = new URLSearchParams({ username: addon.xtream.username, password: addon.xtream.password });
  const endpoint = `${local(addon.xtream.server)}/player_api.php?${auth}&action=get_vod_streams`;
  const [before] = await (await fetch(endpoint)).json();
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
  await require("../server").close();
  const start = seen.length;
  delete require.cache[require.resolve("../server")];
  const runtime = require("../server");
  await runtime.ready;
  app = runtime.server;
  await new Promise((resolve) => app.listen(0, "0.0.0.0", resolve));
  base = `http://127.0.0.1:${app.address().port}/bossmedia`;
  assert.equal(await (await fetch(local(before.direct_source))).text(), "resolved-http-media");
  const [after] = await (await fetch(`${local(addon.xtream.server)}/player_api.php?${auth}&action=get_vod_streams`)).json();
  assert.equal(after.stream_id, before.stream_id);
  assert.equal(seen.slice(start).filter((entry) => entry.path.startsWith("/remote/catalog/")).length, 0);
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.architecture, "canonical-graph");
});

test("admin API throttles failed tokens despite forged forwarding headers and leaves health available", async () => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`${base}/api/addons`, { headers: { "X-Boss-Admin": "incorrect", "X-Forwarded-For": `192.0.2.${attempt}`, "X-Real-IP": `192.0.2.${attempt}` } });
    assert.equal(response.status, 401);
  }
  const blocked = await fetch(`${base}/api/addons`, { headers: { "X-Boss-Admin": token, "X-Forwarded-For": "198.51.100.1" } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

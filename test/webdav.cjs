"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const { createWebDavSource } = require("../sources/webdav");
const { videoName, titleInfo, parseNfo } = require("../sources/webdav-media");
const { MediaEngine } = require("../core/engine");
const secret = "webdav-test-encryption-key-long-enough";
const escape = value => String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const encode = value => value.split("/").map(encodeURIComponent).join("/");
async function fixture() {
  const seen = [], files = new Map([
    ["/dav/Movies/Owned Film (2024) [imdbid-tt1234567]/Owned.Film.2024.1080p.mp4", "original-movie-bytes"],
    ["/dav/Movies/Owned Film (2024) [imdbid-tt1234567]/movie.nfo", '<movie><title>Owned Film</title><year>2024</year><genre>Drama</genre><plot>Local plot</plot><fileinfo><streamdetails><video><codec>h264</codec><height>1080</height><width>1920</width></video></streamdetails></fileinfo></movie>'],
    ["/dav/Movies/Owned Film (2024) [imdbid-tt1234567]/poster.png", Buffer.from([137,80,78,71,13,10,26,10])],
    ["/dav/Movies/Owned Film (2024) [imdbid-tt1234567]/Owned.Film.2024.1080p.en.srt", "1\n00:00:00,000 --> 00:00:01,000\nOwned captions\n"],
    ["/dav/Shows/Owned Show (2022)/tvshow.nfo", '<tvshow><title>Owned Show</title><year>2022</year><uniqueid type="imdb">tt7654321</uniqueid><genre>Comedy</genre></tvshow>'],
    ["/dav/Shows/Owned Show (2022)/poster.jpg", "local-show-poster"],
    ["/dav/Shows/Owned Show (2022)/Season 01/Owned.Show.S01E01.mkv", "original-episode-one"],
    ["/dav/Shows/Owned Show (2022)/Season 01/Owned.Show.S01E01.nfo", '<episodedetails><title>Pilot</title><season>1</season><episode>1</episode><plot>Owned pilot plot</plot></episodedetails>'],
    ["/dav/Shows/Owned Show (2022)/Season 01/Owned.Show.S01E01.fr.vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\nBonjour\n"],
    ["/dav/Shows/Owned Show (2022)/Season 02/Owned.Show.S02E01.m2ts", "original-episode-two"],
    ["/dav/Flat/Flat.Show.2020.S01E01-E02.mp4", "two-episodes-one-file"],
    ["/dav/Flat/Flat.Show.2020.S02E01.mp4", "second-season"],
    ["/dav/Flat/Ignore.torrent", "prohibited"], ["/dav/Flat/Readme.txt", "not-media"]
  ]);
  let failure, malformed = false, expected = `Basic ${Buffer.from("user:private-password").toString("base64")}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture"), pathname = decodeURIComponent(url.pathname);
    seen.push({ method: req.method, path: pathname, authorization: req.headers.authorization });
    if (pathname.startsWith("/metadata/")) {
      assert.equal(req.headers.authorization, undefined);
      res.setHeader("Content-Type", "application/json");
      if (pathname.endsWith("/tt1234567.json")) return res.end(JSON.stringify({ meta: { id: "tt1234567", type: "movie", name: "Owned Film", description: "Remote plot", imdbRating: "8.2", poster: "https://images.example/remote.png", genres: ["Drama"] } }));
      if (pathname.endsWith("/tt7654321.json")) return res.end(JSON.stringify({ meta: { id: "tt7654321", type: "series", name: "Owned Show", videos: [{ season: 1, episode: 1, title: "Remote pilot" }, { season: 2, episode: 1, title: "Return" }, { season: 9, episode: 9, title: "Not owned" }] } }));
      return res.end(JSON.stringify({ metas: [] }));
    }
    if (expected && req.headers.authorization !== expected) { res.writeHead(401); return res.end(); }
    if (failure && pathname.startsWith(failure)) { res.writeHead(503); return res.end(); }
    if (req.method === "PROPFIND") {
      res.writeHead(207, { "Content-Type": "application/xml" });
      if (malformed) return res.end("<broken");
      const entries = new Map([[pathname, true]]);
      if (req.headers.depth !== "0") for (const file of files.keys()) {
        if (!file.startsWith(pathname)) continue;
        const relative = file.slice(pathname.length), first = relative.split("/")[0];
        if (first) entries.set(`${pathname}${first}${relative.includes("/") ? "/" : ""}`, relative.includes("/"));
      }
      res.write('<x:multistatus xmlns:x="DAV:">');
      for (const [entry, directory] of [...entries].reverse()) res.write(`<x:response><x:href>${escape(encode(entry))}</x:href><x:propstat><x:prop><x:displayname>Untrusted label</x:displayname><x:resourcetype>${directory ? "<x:collection/>" : ""}</x:resourcetype><x:getetag>${escape(`etag-${String(files.get(entry)).length}`)}</x:getetag></x:prop><x:status>HTTP/1.1 200 OK</x:status></x:propstat></x:response>`);
      // Cross-origin and encoded path separators must never become media or requests.
      res.write('<x:response><x:href>http://foreign.invalid/steal.mp4</x:href></x:response><x:response><x:href>/dav/evil%2Ffile.mp4</x:href></x:response>');
      return res.end("</x:multistatus>");
    }
    const value = files.get(pathname);
    if (value === undefined) { res.writeHead(404); return res.end(); }
    const data = Buffer.from(value), range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = Number(range?.[1] || 0), end = range?.[2] ? Number(range[2]) : data.length - 1;
    res.writeHead(range ? 206 : 200, { "Content-Type": pathname.endsWith("png") ? "image/png" : pathname.endsWith("jpg") ? "image/jpeg" : pathname.endsWith("nfo") ? "application/xml" : /\.(srt|vtt)$/.test(pathname) ? "text/plain" : "video/mp4", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, ...(range ? { "Content-Range": `bytes ${start}-${end}/${data.length}` } : {}) });
    res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, files, seen, source: { id: "dav", protocol: "webdav", revision: 1, configuration: { baseUrl: base, libraryPath: "/dav", username: "user", password: "private-password" } },
    fail: value => { failure = value; }, malformed: value => { malformed = value; }, auth: value => { expected = value; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
test("WebDAV filename and bounded NFO metadata parsing", () => {
  assert.deepEqual(titleInfo("Owned.Film.(2024).[imdbid-tt1234567].1080p"), { title: "Owned Film", year: 2024, externalIDs: { imdb: "tt1234567" } });
  assert.deepEqual(videoName("Show.S01E01-E03.mkv").episodeNumbers, [1,2,3]);
  assert.equal(videoName("Show.2x03.Title.mp4").seasonNumber, 2);
  assert.equal(videoName("Show.S00E01.mkv").seasonNumber, 0);
  assert.equal(videoName("file.torrent"), null);
  assert.equal(titleInfo("2010 The Year We Make Contact (1984)").year, 1984);
  assert.equal(titleInfo("1917 (2019)").title, "1917");
  assert.throws(() => parseNfo('<!DOCTYPE movie [<!ENTITY x SYSTEM "file:///etc/passwd">]><movie><title>&x;</title></movie>'));
  assert.throws(() => parseNfo("<movie>" + "x".repeat(1048576) + "</movie>"));
  assert.equal(parseNfo("<movie><title>A &amp; B</title><runtime>12</runtime></movie>").runtimeSeconds, 720);
});
test("WebDAV indexed hierarchy, metadata, rescans, source isolation and persistent synthetic identities", async () => {
  const f = await fixture(), dir = await fs.mkdtemp("/tmp/boss-dav-test-");
  const previous = process.env.BOSS_CINEMETA_URL; process.env.BOSS_CINEMETA_URL = `${f.base}/metadata`;
  let engine = new MediaEngine(`${dir}/db.sqlite`, { secret });
  try {
    await engine.addSource({ ...f.source, name: "Owned WebDAV" });
    await engine.ingestor.ingest("dav", { key: "files" });
    await engine.ingestSource("dav");
    const page = types => engine.page({ sourceIds: ["dav"], types, limit: 100 });
    assert.equal(page(["movie"]).length, 1); assert.equal(page(["series"]).length, 2); assert.equal(page(["episode"]).length, 5);
    assert.ok(!f.seen.some(row => row.method === "GET" && /\.(mp4|mkv|m2ts)$/.test(row.path)), "Ingestion must not fetch playable media");
    const movie = page(["movie"])[0], series = page(["series"]).find(row => row.title === "Owned Show");
    assert.equal(movie.externalIDs.imdb, "tt1234567"); assert.equal(movie.title, "Owned Film");
    engine.graph.addSource({ id: "duplicate", protocol: "fixture", name: "Other authorized source", configuration: {} });
    const [duplicate] = engine.graph.ingest("duplicate", [{ sourceKey: "same-film", type: "movie", title: "Owned Film", externalIDs: { imdb: "tt1234567" } }]);
    assert.equal(duplicate, movie.id, "Reliable identities merge across sources");
    const movieId = engine.synthetic("xtream", movie.id), seriesId = engine.synthetic("xtream", series.id);
    const enriched = await engine.metadata(movie.id, { allowedSourceIds: ["dav"] });
    assert.equal(enriched.rating, 8.2); assert.equal(enriched.description, "Local plot");
    assert.ok(engine.artwork(movie.id, ["dav"]).poster.resource.url.includes("poster.png"));
    await engine.metadata(series.id, { allowedSourceIds: ["dav"] });
    assert.equal(page(["episode"]).length, 5, "Metadata provider must not add unowned episodes");
    const episode = page(["episode"]).find(row => row.seriesId === series.id && row.seasonNumber === 2);
    assert.equal((await engine.metadata(episode.id, { allowedSourceIds: ["dav"] })).title, "Return");
    const result = await engine.resolve(movie.id, { allowedSourceIds: ["dav"], codecs: ["h264"], maxHeight: 1080, strictCapabilities: true });
    assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].codec, "h264");
    const subs = await engine.subtitles(movie.id, { allowedSourceIds: ["dav"] });
    assert.equal(subs[0].language, "en"); assert.ok(subs[0].resource.headers.Authorization);
    engine.graph.addSource({ id: "outside", protocol: "fixture", name: "Other", configuration: {} });
    assert.throws(() => engine.graph.ingest("outside", [{ type: "episode", sourceKey: "forged", title: "Denied", seriesRef: { sourceKey: engine.graph.mappings(series.id, ["dav"])[0].sourceKey }, seasonNumber: 1, episodeNumber: 1 }]), /canonical series/);
    const removed = [...f.files.keys()].find(name => name.endsWith("S02E01.m2ts")); f.files.delete(removed);
    f.files.set("/dav/Shows/Owned Show (2022)/Season 03/Owned.Show.S03E01.mkv", "new-episode");
    f.fail("/dav/Shows/"); await assert.rejects(engine.ingestSource("dav", { refresh: true }));
    assert.ok(engine.graph.mappings(episode.id, ["dav"]).length, "Failed scan must not retire previous files");
    f.fail(null); await engine.ingestSource("dav", { refresh: true, indexEpisodes: false });
    assert.equal(engine.graph.mappings(episode.id, ["dav"]).length, 0);
    assert.ok(page(["episode"]).some(row => row.seasonNumber === 3));
    assert.equal(engine.synthetic("xtream", movie.id), movieId);
    await engine.close(); engine = new MediaEngine(`${dir}/db.sqlite`, { secret });
    assert.equal(engine.graph.fromSynthetic("xtream", movieId).canonicalId, movie.canonicalId);
    assert.equal(engine.graph.fromSynthetic("xtream", seriesId).canonicalId, series.canonicalId);
    f.auth("Bearer dav-token");
    await createWebDavSource({ ...f.source, configuration: { baseUrl: f.base, libraryPath: "/dav", apiKey: "dav-token" } });
    await assert.rejects(createWebDavSource(f.source), { status: 401 });
  } finally { await engine.close(); await f.close(); await fs.rm(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.BOSS_CINEMETA_URL; else process.env.BOSS_CINEMETA_URL = previous; }
});

test("WebDAV scans large unordered folders in bounded pages and cleans temporary indexes on cancellation", async () => {
  const f = await fixture();
  try {
    f.files.clear();
    for (let i = 0; i < 2500; i++) f.files.set(`/dav/Movie ${String(i).padStart(4, "0")}.mp4`, "original");
    const previous = new Set((await fs.readdir("/tmp")).filter(name => name.startsWith("boss-dav-")));
    const adapter = await createWebDavSource(f.source), controller = new AbortController();
    const scan = adapter.scanCatalog({ limit: 200, signal: controller.signal });
    assert.equal((await scan.next()).value.items.length, 200);
    controller.abort(); await assert.rejects(scan.next());
    assert.deepEqual(new Set((await fs.readdir("/tmp")).filter(name => name.startsWith("boss-dav-"))), previous);
    let total = 0;
    for await (const page of adapter.scanCatalog({ limit: 200 })) { assert.ok(page.items.length <= 200); total += page.items.length; }
    assert.equal(total, 2500);
    assert.ok(!f.seen.some(row => row.method === "GET"));
    f.malformed(true);
    await assert.rejects(createWebDavSource(f.source));
    assert.deepEqual(new Set((await fs.readdir("/tmp")).filter(name => name.startsWith("boss-dav-"))), previous);
  } finally { await f.close(); }
});

test("WebDAV movies and episodes work through native, Xtream, M3U and compatibility HTTP outputs", async () => {
  const f = await fixture(), dir = await fs.mkdtemp("/tmp/boss-dav-http-");
  const saved = { ...process.env }; let runtime;
  try {
    const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, "0.0.0.0", resolve));
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}/bossmedia`, admin = "webdav-http-admin-test";
    Object.assign(process.env, { DATA_DIR: dir, PUBLIC_BASE_URL: base, BOSS_ADMIN_TOKEN: admin, BOSS_SECRET: secret, BOSS_CINEMETA_URL: `${f.base}/metadata` });
    runtime = require("../server"); await runtime.ready; await new Promise(resolve => runtime.server.listen(port, "0.0.0.0", resolve));
    const response = await fetch(`${base}/api/addons`, { method: "POST", headers: { "Content-Type": "application/json", "X-Boss-Admin": admin }, body: JSON.stringify({ sourceType: "webdav", name: "Owned", ...f.source.configuration }) });
    assert.equal(response.status, 201); const { addon } = await response.json();
    await runtime.engine.ingestSource(addon.id);
    const { BossClient } = await import("../public/boss-client.mjs");
    const clients = [await BossClient.fromAddon(addon.bossUrl), await BossClient.fromXtream(addon.xtream.server, addon.xtream.username, addon.xtream.password), await BossClient.fromM3u(addon.playlistUrl)];
    for (const client of clients) {
      const movies = await client.catalogue({ type: "movie" }), shows = await client.catalogue({ type: "series" });
      assert.equal(movies.items.length, 1); assert.equal(shows.items.length, 2);
      const movie = movies.items[0];
      const playback = await client.playback(movie.id);
      assert.ok(!JSON.stringify(playback).includes("private-password"));
      assert.equal(playback.resources[0].delivery, "direct");
      const resource = await fetch(playback.resources[0].url, { headers: { ...playback.resources[0].requiredHeaders, Range: "bytes=0-7" } });
      assert.equal(resource.status, 206); assert.equal(await resource.text(), "original");
      const subtitles = await client.subtitles(movie.id); assert.equal(subtitles.subtitles.length, 1);
      assert.match(await (await fetch(subtitles.subtitles[0].url, { headers: subtitles.subtitles[0].requiredHeaders })).text(), /Owned captions/);
      assert.equal((await fetch(movie.artwork.poster, { headers: { Authorization: `Basic ${Buffer.from("user:private-password").toString("base64")}` } })).status, 200);
      const show = shows.items.find(item => item.title === "Owned Show");
      const episodes = await client.catalogue({ type: "episode", seriesId: show.id }); assert.equal(episodes.items.length, 2);
      for (const episode of episodes.items) {
        const resource = (await client.playback(episode.id)).resources[0];
        assert.match(await (await fetch(resource.url, { headers: resource.requiredHeaders })).text(), /^original-episode/);
      }
    }
    const auth = new URLSearchParams({ username: addon.xtream.username, password: addon.xtream.password });
    const get = async params => (await fetch(`${addon.xtream.server}/player_api.php?${auth}&${new URLSearchParams(params)}`)).json();
    const shows = await get({ action: "get_series" });
    const show = shows.find(row => row.name === "Owned Show"); const info = await get({ action: "get_series_info", series_id: show.series_id });
    assert.deepEqual(Object.keys(info.episodes), ["1", "2"]);
    assert.equal(info.episodes["1"][0].container_extension, "mkv"); assert.equal(info.episodes["2"][0].container_extension, "m2ts");
    for (const entries of Object.values(info.episodes)) {
      const handoff = await fetch(entries[0].direct_source, { redirect: "manual" });
      assert.equal(handoff.status, 307);
      assert.match(handoff.headers.get("location"), /\/dav\/Shows\//);
    }
    const playlist = await (await fetch(addon.playlistUrl)).text(); assert.match(playlist, /\/series\//); assert.ok(!playlist.includes("private-password"));
    const compatibility = new URL("./", addon.installUrl).href;
    const catalog = await (await fetch(`${compatibility}catalog/series/boss-series.json`)).json();
    const meta = await (await fetch(`${compatibility}meta/series/${encodeURIComponent(catalog.metas.find(row => row.name === "Owned Show").id)}.json`)).json();
    assert.equal(meta.meta.videos.length, 2);
    const stream = await (await fetch(`${compatibility}stream/series/${encodeURIComponent(meta.meta.videos[0].id)}.json`)).json();
    assert.match(await (await fetch(stream.streams[0].url, { headers: stream.streams[0].behaviorHints.proxyHeaders.request })).text(), /^original-episode/);
    const remove = await fetch(`${base}/api/addons/${addon.id}`, { method: "DELETE", headers: { "X-Boss-Admin": admin } }); assert.equal(remove.status, 200);
    assert.equal((await fetch(info.episodes["1"][0].direct_source)).status, 404);
  } finally { if (runtime) { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); await runtime.close(); } await f.close(); await fs.rm(dir, { recursive: true, force: true }); for (const key of ["DATA_DIR", "PUBLIC_BASE_URL", "BOSS_ADMIN_TOKEN", "BOSS_SECRET", "BOSS_CINEMETA_URL"]) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});

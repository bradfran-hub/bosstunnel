"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify, parseEnv } = require("node:util");
const run = promisify(execFile);
async function main() {
  const dir = await fs.mkdtemp("/tmp/boss-client-");
  const token = crypto.randomBytes(24).toString("hex");
  let runtime, base, admin, sourceBase, upstream;
  const created = [];
  const results = [];
  const nativeAddons = new Map();
  try {
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-g", "10", "-c:a", "aac", "-movflags", "+faststart", path.join(dir, "clip.mp4")]);
    await run("ffmpeg", ["-v", "error", "-i", path.join(dir, "clip.mp4"), "-c", "copy", "-hls_time", "1", "-hls_list_size", "0", "-hls_segment_filename", path.join(dir, "segment%d.ts"), path.join(dir, "stream.m3u8")]);
    await run("ffmpeg", ["-v", "error", "-i", path.join(dir, "clip.mp4"), "-c", "copy", path.join(dir, "clip.mkv")]);
    upstream = http.createServer((req, res) => {
      let pathname = new URL(req.url, "http://test").pathname;
      const dav = pathname.match(/^\/webdav-(mp4|mkv)\//);
      if (dav) {
        if (req.headers.authorization !== `Basic ${Buffer.from(`user:${token}`).toString("base64")}`) { res.writeHead(401); return res.end(); }
        if (req.method === "PROPFIND") {
          const root = `/webdav-${dav[1]}/`, child = pathname !== root;
          const entries = [[pathname, true], ...(req.headers.depth === "0" ? [] : child ? [[`${root}Show/Generated.Show.S01E01.${dav[1]}`, false]] : [[`${root}Generated.movie.${dav[1]}`, false], [`${root}Show/`, true]])];
          res.writeHead(207, { "Content-Type": "application/xml" });
          return res.end(`<d:multistatus xmlns:d="DAV:">${entries.map(([url, directory]) => `<d:response><d:href>${url}</d:href><d:propstat><d:prop><d:resourcetype>${directory ? "<d:collection/>" : ""}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`);
        }
        if (!pathname.endsWith(`.${dav[1]}`)) { res.writeHead(404); return res.end(); }
        pathname = `/clip.${dav[1]}`;
      }
      const native = nativeAddons.get(pathname.split("/")[1]);
      if (native) return native.emit("request", req, res);
      res.setHeader("Content-Type", "application/json");
      const match = pathname.match(/^\/(mp4|hls)\/(.*)$/);
      if (match?.[2] === "manifest.json") return res.end(JSON.stringify({ id: `test.playback.${match[1]}`, version: "1.0.0", name: "Generated test pattern", resources: ["catalog", "stream"], types: ["movie"], catalogs: [{ id: "fixture", type: "movie" }] }));
      if (match?.[2].startsWith("catalog/")) return res.end(JSON.stringify({ metas: [{ id: "generated-pattern", type: "movie", name: "Generated test pattern" }] }));
      if (match?.[2].startsWith("stream/")) return res.end(JSON.stringify({ streams: [{ url: `${sourceBase}/${match[1] === "mp4" ? "clip.mp4" : "stream.m3u8"}`, behaviorHints: { proxyHeaders: { request: { Authorization: `Bearer ${token}` } } } }] }));
      if (!["/clip.mp4", "/clip.mkv", "/stream.m3u8", "/segment0.ts", "/segment1.ts", "/segment2.ts", "/segment3.ts"].includes(pathname)) { res.writeHead(404); return res.end(); }
      if (!dav && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(); }
      (async () => {
        const data = await fs.readFile(path.join(dir, pathname.slice(1)));
        const headers = { "Content-Type": pathname.endsWith("mp4") ? "video/mp4" : pathname.endsWith("mkv") ? "video/x-matroska" : pathname.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t", "Accept-Ranges": "bytes" };
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${data.length}` }); return res.end(); }
        if (range) headers["Content-Range"] = `bytes ${start}-${end}/${data.length}`;
        res.writeHead(range ? 206 : 200, { ...headers, "Content-Length": end - start + 1 });
        res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
      })().catch(() => res.destroy());
    });
    await new Promise((resolve) => upstream.listen(Number(process.env.TEST_FIXTURE_PORT || 0), "0.0.0.0", resolve));
    sourceBase = `http://${process.env.TEST_SOURCE_HOST || "127.0.0.1"}:${upstream.address().port}`;
    const { createBossAddon } = await import("../public/boss-addon.mjs");
    for (const kind of ["mp4", "hls"]) {
      const media = { id: "generated-pattern", type: "movie", title: "Generated test pattern" };
      const channel = { id: "generated-channel", type: "channel", title: "Generated archive", channel: { catchupDays: 2 } };
      const resources = () => [{ url: `${sourceBase}/${kind === "mp4" ? "clip.mp4" : "stream.m3u8"}`, protocol: kind === "hls" ? "hls" : "http", codec: "h264", resolution: { width: 320, height: 180 }, requiredHeaders: { Authorization: `Bearer ${token}` } }];
      nativeAddons.set(`boss-${kind}`, createBossAddon({ id: `test.boss.${kind}`, name: media.title, baseUrl: `${sourceBase}/boss-${kind}`, types: ["movie", "channel"], token: `addon-${token}` }, {
        catalogue: async ({ type }) => ({ items: [type === "channel" ? channel : media], next: null }),
        media: async ({ id }) => id === channel.id ? channel : media,
        playback: async () => resources(),
        catchup: async ({ start, end }) => { assert.ok(end > start); return resources(); }
      }));
    }
    if (process.env.TEST_PUBLIC_BASE) {
      base = process.env.TEST_PUBLIC_BASE;
      admin = process.env.BOSS_ADMIN_TOKEN;
      if (!admin) admin = parseEnv(await fs.readFile(path.join(__dirname, "../.env"), "utf8")).BOSS_ADMIN_TOKEN;
      assert.ok(admin);
    } else {
      admin = "real-client-test-admin-token-long-enough";
      const reservation = http.createServer();
      await new Promise((resolve) => reservation.listen(0, "0.0.0.0", resolve));
      const port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      base = `http://127.0.0.1:${port}/bossmedia`;
      Object.assign(process.env, { DATA_DIR: dir, BOSS_ADMIN_TOKEN: admin, BOSS_SECRET: "real-client-test-encryption-key-long-enough", PUBLIC_BASE_URL: base });
      if (process.env.TEST_JELLYFIN_OUTPUT === "true") process.env.BOSS_JELLYFIN_OUTPUT = "true";
      runtime = require("../server");
      await runtime.ready;
      await new Promise((resolve) => runtime.server.listen(port, "0.0.0.0", resolve));
    }
    const headers = { "Content-Type": "application/json", "X-Boss-Admin": admin };
    const local = (url) => url.replace("http://client.test/bossmedia", base);
    for (const kind of ["mp4", "hls", "boss-mp4", "boss-hls", "webdav-mp4", "webdav-mkv"]) {
      const native = kind.startsWith("boss-");
      const dav = kind.startsWith("webdav-");
      const response = await fetch(`${base}/api/addons`, { method: "POST", headers, body: JSON.stringify({ sourceType: dav ? "webdav" : native ? "boss" : "other", name: `Playback verification ${kind}`, baseUrl: `${sourceBase}/${kind}/${dav ? "" : native ? "addon" : "manifest.json"}`, ...(native ? { apiKey: `addon-${token}` } : dav ? { username: "user", password: token } : {}) }) });
      assert.equal(response.status, 201, "Create playback fixture source");
      const { addon } = await response.json(); created.push(addon.id);
      for (let attempt = 0; attempt < 100; attempt++) {
        const source = (await (await fetch(`${base}/api/addons`, { headers })).json()).addons.find((row) => row.id === addon.id);
        if (!source.syncing) { assert.equal(source.sync.status, "complete"); break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const root = local(addon.installUrl).replace("/manifest.json", "");
      const { BossClient } = await import("../public/boss-client.mjs");
      const clients = await Promise.all([BossClient.fromAddon(local(addon.bossUrl)), BossClient.fromXtream(local(addon.xtream.server), addon.xtream.username, addon.xtream.password), BossClient.fromM3u(local(addon.playlistUrl))]);
      const searches = await Promise.all(clients.map((client) => client.search("Generated", { type: "movie", limit: 100 })));
      assert.ok(searches[0].items.length);
      assert.deepEqual(searches[0].items.map((item) => item.id), searches[1].items.map((item) => item.id));
      assert.deepEqual(searches[0].items.map((item) => item.id), searches[2].items.map((item) => item.id), "Boss, Xtream and M3U SDK discovery must use one search contract");
      const { metas } = await (await fetch(`${root}/catalog/movie/boss-movie.json`)).json();
      const { streams } = await (await fetch(`${root}/stream/movie/${encodeURIComponent(metas[0].id)}.json`)).json();
      const auth = new URLSearchParams({ username: addon.id, password: addon.xtream.password });
      const [movie] = await (await fetch(`${local(addon.xtream.server)}/player_api.php?${auth}&action=get_vod_streams`)).json();
      const playlist = await (await fetch(local(addon.playlistUrl))).text();
      const urls = { addon: local(streams[0].url), xtream: local(movie.direct_source), m3u: local(playlist.split("\n").find((line) => line.startsWith("http"))) };
      urls.boss = local((await clients[0].playback(searches[0].items[0].id)).resources[0].url);
      if (process.env.TEST_JELLYFIN_OUTPUT === "true") {
        const provisioned = await fetch(`${base}/api/libraries/${addon.id}/outputs/jellyfin`, { method: "POST", headers });
        assert.equal(provisioned.status, 201);
        const credentials = await provisioned.json();
        const { Jellyfin } = await import("@jellyfin/sdk");
        const { getUserApi } = await import("@jellyfin/sdk/lib/utils/api/user-api.js");
        const { getMediaInfoApi } = await import("@jellyfin/sdk/lib/utils/api/media-info-api.js");
        const sdk = new Jellyfin({ clientInfo: { name: "Boss Generated Video Test", version: "1" }, deviceInfo: { name: "FFmpeg", id: `fixture-${kind}` } });
        const session = (await getUserApi(sdk.createApi(credentials.server)).authenticateUserByName({ authenticateUserByName: { Username: credentials.username, Pw: credentials.password } })).data;
        const api = sdk.createApi(credentials.server, session.AccessToken);
        const playback = async item => (await getMediaInfoApi(api).getPostedPlaybackInfo({ itemId: item.id.replaceAll("-", ""), playbackInfoDto: { EnableDirectPlay: true, EnableTranscoding: false } })).data.MediaSources[0].DirectStreamUrl;
        urls.jellyfin = await playback(searches[0].items[0]);
        if (dav) {
          const [show] = (await clients[0].catalogue({ type: "series" })).items;
          const [episode] = (await clients[0].catalogue({ type: "episode", seriesId: show.id })).items;
          urls["jellyfin-episode"] = await playback(episode);
        }
        if (native) urls["jellyfin-live"] = await playback((await clients[0].catalogue({ type: "channel" })).items[0]);
      }
      if (dav) {
        const [show] = (await clients[0].catalogue({ type: "series" })).items;
        const [episode] = (await clients[0].catalogue({ type: "episode", seriesId: show.id })).items;
        for (const [index, client] of clients.entries()) urls[`episode-${["boss", "xtream-sdk", "m3u-sdk"][index]}`] = local((await client.playback(episode.id)).resources[0].url);
        const [wireShow] = await (await fetch(`${local(addon.xtream.server)}/player_api.php?${auth}&action=get_series`)).json();
        const info = await (await fetch(`${local(addon.xtream.server)}/player_api.php?${auth}&action=get_series_info&series_id=${wireShow.series_id}`)).json();
        urls["episode-xtream"] = local(info.episodes["1"][0].direct_source);
        urls["episode-m3u"] = local(playlist.split("\n").find(line => line.startsWith("http") && line.includes("/series/")));
        const showMeta = await (await fetch(`${root}/meta/series/boss:${show.id}.json`)).json();
        const episodeStreams = await (await fetch(`${root}/stream/series/${encodeURIComponent(showMeta.meta.videos[0].id)}.json`)).json();
        urls["episode-addon"] = local(episodeStreams.streams[0].url);
      }
      if (native) {
        const [channel] = (await clients[0].catalogue({ type: "channel" })).items;
        const end = Math.floor((Date.now() - 3600000) / 60000) * 60000, start = end - 1800000;
        for (const [index, client] of clients.entries()) {
          assert.equal(client.descriptor.playbackCapabilities?.version, 1);
          const capabilities = { codecs: ["h264"], maxHeight: 180, hdr: false, strictCapabilities: true };
          const negotiated = await client.playback(searches[index].items[0].id, { capabilities });
          urls[`capabilities-${["boss", "xtream-sdk", "m3u-sdk"][index]}`] = local(negotiated.resources[0].url);
          const archive = await client.catchup(channel.id, { start, end, capabilities });
          assert.equal(new URL(archive.resources[0].url).searchParams.get("boss_codecs"), "h264");
          urls[`archive-${["boss", "xtream-sdk", "m3u-sdk"][index]}`] = local(archive.resources[0].url);
        }
        const stamp = new Date(start).toISOString().slice(0, 16).replace("T", ":").replace(/:(\d{2})$/, "-$1");
        urls["archive-xtream"] = `${local(addon.xtream.server)}/timeshift/${addon.xtream.username}/${addon.xtream.password}/30/${stamp}/${channel.xtreamId}.ts`;
      }
      for (const [format, url] of Object.entries(urls)) {
        const response = await fetch(url);
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!kind.endsWith("hls")) {
          const mkv = kind.endsWith("mkv");
          assert.equal(response.headers.get("content-type"), mkv ? "video/x-matroska" : "video/mp4");
          assert.deepEqual(bytes, await fs.readFile(path.join(dir, mkv ? "clip.mkv" : "clip.mp4")), "Media bytes must pass through unchanged");
        } else {
          assert.match(response.headers.get("content-type"), /mpegurl/);
          const segments = bytes.toString().split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
          assert.equal(segments.length, 4);
          for (const [index, segment] of segments.entries()) {
            const child = await fetch(local(segment));
            assert.equal(child.status, 200);
            assert.deepEqual(Buffer.from(await child.arrayBuffer()), await fs.readFile(path.join(dir, `segment${index}.ts`)), "HLS segment bytes must pass through unchanged");
          }
        }
        const { stdout } = await run("ffmpeg", ["-v", "error", "-i", url, "-map", "0:v:0", "-an", "-f", "framemd5", "pipe:1"], { timeout: 60000, maxBuffer: 1024 * 1024 });
        const frames = stdout.split("\n").filter((line) => line && !line.startsWith("#"));
        assert.equal(frames.length, 40, `${kind}/${format} must decode all generated frames: ${stdout}`);
        assert.ok(new Set(frames.map((frame) => frame.split(",").at(-1))).size > 1, "Decoded frames must contain moving imagery");
        let seekFrames;
        if (format.startsWith("jellyfin")) {
          const args = input => ["-v", "error", "-ss", "1", "-i", input, "-map", "0:v:0", "-an", "-frames:v", "5", "-f", "framemd5", "pipe:1"];
          const original = path.join(dir, kind.endsWith("hls") ? "stream.m3u8" : kind.endsWith("mkv") ? "clip.mkv" : "clip.mp4");
          const expected = await run("ffmpeg", args(original), { timeout: 60000, maxBuffer: 1024 * 1024 });
          const actual = await run("ffmpeg", args(url), { timeout: 60000, maxBuffer: 1024 * 1024 });
          const hashes = value => value.split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1).trim());
          assert.equal(hashes(actual.stdout).length, 5, `${kind}/${format} must decode five seek frames`);
          assert.deepEqual(hashes(actual.stdout), hashes(expected.stdout), "Seeking must decode the same original frames");
          seekFrames = 5;
        }
        results.push({ source: kind, output: format, frames: frames.length, mediaBytesUnchanged: true, ...(seekFrames ? { seekFrames } : {}) });
      }
    }
    await fs.mkdir(path.join(__dirname, "../artifacts"), { recursive: true });
    const report = process.env.TEST_REPORT_NAME || `playback-${process.env.TEST_PUBLIC_BASE ? "public" : "local"}.json`;
    assert.match(report, /^[a-z0-9-]+\.json$/, "Report name must be a simple artifact filename");
    await fs.writeFile(path.join(__dirname, "../artifacts", report), JSON.stringify({ player: "FFmpeg", results }, null, 2));
    console.log(JSON.stringify({ player: "FFmpeg", results }));
  } finally {
    for (const id of created) await fetch(`${base}/api/addons/${id}`, { method: "DELETE", headers: { "X-Boss-Admin": admin } });
    if (runtime) { runtime.server.closeAllConnections(); await new Promise((resolve) => runtime.server.close(resolve)); await runtime.close(); }
    if (upstream) { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); }
    if (process.env.TEST_KEEP_FILES) console.log(`Playback artifacts: ${dir}`);
    else await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message.replace(/https?:\/\/\S+/g, "[media URL]"), error.status ? `HTTP ${error.status}` : ""); process.exitCode = 1; });

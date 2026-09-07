"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const { capabilities } = require("../core/model");
const { directPlayable } = require("../protocols/media-server-profile");
const { normalizeCandidate } = require("../core/resolver");

test("direct-play profiles enforce known codecs, bitrate, channels and required conditions", () => {
  const candidate = normalizeCandidate({ url: "https://owned.example/movie.mp4", codec: "h264", container: "mp4", bitrate: 2000000,
    resolution: { width: 1920, height: 1080 }, video: { profile: "high", bitDepth: 8 }, audio: [{ codec: "aac", channels: 2, index: 1 }] }, "owned");
  const profile = { DeviceProfile: { DirectPlayProfiles: [{ Type: "Video", Container: "mp4", VideoCodec: "avc1", AudioCodec: "aac" }] } };
  assert.equal(directPlayable(candidate, profile), true);
  for (const extra of [{ EnableDirectPlay: false }, { MaxStreamingBitrate: 1000000 }, { MaxAudioChannels: 1 }, { AudioStreamIndex: 4 }]) assert.equal(directPlayable(candidate, { ...profile, ...extra }), false);
  assert.equal(directPlayable({ ...candidate, codec: null }, profile), false);
  assert.equal(directPlayable({ ...candidate, bitrate: null }, { ...profile, MaxStreamingBitrate: 5000000 }), false);
  assert.equal(directPlayable({ ...candidate, audio: [] }, profile), false);
  const limited = conditions => ({ DeviceProfile: { ...profile.DeviceProfile, CodecProfiles: [{ Type: "Video", Codec: "h264", Conditions: conditions }] } });
  assert.equal(directPlayable(candidate, limited([{ Property: "Height", Condition: "LessThanEqual", Value: "720", IsRequired: true }])), false);
  assert.equal(directPlayable(candidate, limited([{ Property: "VideoBitDepth", Condition: "Equals", Value: "8", IsRequired: true }])), true);
  assert.equal(directPlayable(candidate, limited([{ Property: "Unknown", Condition: "Equals", Value: "8", IsRequired: true }])), false);
  assert.throws(() => directPlayable(candidate, { DeviceProfile: { DirectPlayProfiles: Array(65).fill({}) } }), { status: 422 });
});

test("official SDK resolves exact upstream playback lazily and persists user state", async () => {
  const dir = await fs.mkdtemp("/tmp/boss-jellyfin-play-");
  const bytes = Buffer.from("0123456789-original-authorized-media");
  const subtitle = "WEBVTT\n\n00:00.000 --> 00:01.000\nOwned subtitle\n";
  let runtime, upstream, requests = 0, resolutions = 0, mode = "mp4", releaseSlow;
  try {
    upstream = http.createServer((req, res) => {
      requests++;
      if (req.headers.authorization !== "Bearer upstream-private") { res.writeHead(401); return res.end(); }
      const pathname = new URL(req.url, "http://fixture").pathname;
      if (pathname === "/subtitle.vtt") { res.writeHead(200, { "Content-Type": "text/vtt" }); return res.end(subtitle); }
      if (pathname === "/bad.vtt") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<script>bad</script>"); }
      if (pathname === "/movie.m3u8") {
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        return res.end("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n");
      }
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      const start = range ? Number(range[1]) : 0, end = range ? Number(range[2]) : bytes.length - 1;
      res.writeHead(range ? 206 : 200, { "Content-Type": pathname.endsWith(".ts") ? "video/mp2t" : "video/mp4", "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}) });
      if (req.method === "HEAD") return res.end();
      if (pathname === "/slow.mp4") { res.write(bytes.subarray(0, 8)); releaseSlow = () => res.end(bytes.subarray(8)); return; }
      res.end(bytes.subarray(start, end + 1));
    });
    await new Promise(resolve => upstream.listen(0, "0.0.0.0", resolve));
    const origin = `http://127.0.0.1:${upstream.address().port}`;
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, "0.0.0.0", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}/bossmedia`;
    Object.assign(process.env, { DATA_DIR: dir, BOSS_ADMIN_TOKEN: "jellyfin-test-admin", BOSS_SECRET: "test-playback-secret-at-least-32-characters", PUBLIC_BASE_URL: base, BOSS_JELLYFIN_OUTPUT: "true" });
    runtime = require("../server"); await runtime.ready;
    await new Promise(resolve => runtime.server.listen(port, "0.0.0.0", resolve));
    const { graph, registry } = runtime.engine;
    const declaration = capabilities({ catalog: true, streams: true, subtitles: true, types: ["movie", "episode", "series", "channel"] });
    registry.register("play-fixture", source => ({ id: source.id, capabilities: declaration, catalogs: [], resolutionTtlMs: 0,
      async catalog() { return { items: [], nextCursor: null }; },
      async resolve() { resolutions++; return [{ resource: { url: `${origin}/${mode === "slow" ? "slow.mp4" : `movie.${mode}`}` }, requiredHeaders: { Authorization: "Bearer upstream-private" },
        codec: "h264", container: "mp4", bitrate: 1000000, audio: [{ codec: "aac", channels: 2, index: 1 }] }]; },
      async subtitles() { return ["subtitle.vtt", "bad.vtt"].map(file => ({ id: file, language: "eng", resource: { url: `${origin}/${file}`, headers: { Authorization: "Bearer upstream-private" } } })); }
    }));
    for (const id of ["owned", "excluded"]) graph.addSource({ id, protocol: "play-fixture", name: id, configuration: {}, capabilities: declaration });
    const [movie, series, channel] = graph.ingest("owned", [{ type: "movie", sourceKey: "movie", title: "Owned movie" }, { type: "series", sourceKey: "series", title: "Owned series" }, { type: "channel", sourceKey: "channel", title: "Owned live" }]);
    const [episode] = graph.ingest("owned", [{ type: "episode", sourceKey: "episode", title: "Owned episode", seriesId: series, seasonNumber: 1, episodeNumber: 1 }]);
    graph.ingest("owned", [{ type: "episode", sourceKey: "later", title: "Later episode", seriesId: series, seasonNumber: 2, episodeNumber: 3 }, { type: "episode", sourceKey: "earlier", title: "Earlier episode", seriesId: series, seasonNumber: 2, episodeNumber: 1 }]);
    const [excluded] = graph.ingest("excluded", [{ type: "movie", sourceKey: "excluded", title: "Excluded" }]);
    const collection = graph.createCollection({ name: "Playback customer", sourceIds: ["owned"] });
    const provision = await fetch(`${base}/api/libraries/${collection.id}/outputs/jellyfin`, { method: "POST", headers: { "X-Boss-Admin": process.env.BOSS_ADMIN_TOKEN } });
    assert.equal(provision.status, 201);
    const credentials = await provision.json(); assert.equal(credentials.playback, true);
    const { Jellyfin } = await import("@jellyfin/sdk");
    const { getUserApi } = await import("@jellyfin/sdk/lib/utils/api/user-api.js");
    const { getItemsApi } = await import("@jellyfin/sdk/lib/utils/api/items-api.js");
    const { getMediaInfoApi } = await import("@jellyfin/sdk/lib/utils/api/media-info-api.js");
    const { getPlaystateApi } = await import("@jellyfin/sdk/lib/utils/api/playstate-api.js");
    const { getUserLibraryApi } = await import("@jellyfin/sdk/lib/utils/api/user-library-api.js");
    const { getSessionApi } = await import("@jellyfin/sdk/lib/utils/api/session-api.js");
    const { getTvShowsApi } = await import("@jellyfin/sdk/lib/utils/api/tv-shows-api.js");
    const { getLiveTvApi } = await import("@jellyfin/sdk/lib/utils/api/live-tv-api.js");
    const sdk = new Jellyfin({ clientInfo: { name: "Boss Playback Test", version: "1" }, deviceInfo: { name: "Test", id: "playback-test" } });
    const login = async () => (await getUserApi(sdk.createApi(credentials.server)).authenticateUserByName({ authenticateUserByName: { Username: credentials.username, Pw: credentials.password } })).data;
    let session = await login(), api = sdk.createApi(credentials.server, session.AccessToken);
    assert.equal(session.User.Policy.EnableMediaPlayback, true);
    assert.equal(session.User.Policy.EnableVideoPlaybackTranscoding, false);
    const id = value => graph.media(value).canonicalId.replaceAll("-", "");
    const items = (await getItemsApi(api).getItems({ includeItemTypes: ["Movie"] })).data;
    assert.equal(items.Items.length, 1); assert.equal(resolutions, 0); assert.equal(requests, 0);
    const seasons = (await getTvShowsApi(api).getSeasons({ seriesId: id(series) })).data;
    assert.deepEqual(seasons.Items.map(row => row.IndexNumber), [1, 2]);
    const episodes = (await getTvShowsApi(api).getEpisodes({ seriesId: id(series), season: 2 })).data;
    assert.deepEqual(episodes.Items.map(row => row.IndexNumber), [1, 3]);
    assert.equal(episodes.TotalRecordCount, 2);
    assert.equal((await getTvShowsApi(api).getEpisodes({ seriesId: id(series), seasonId: seasons.Items[1].Id, startIndex: 1, limit: 1 })).data.TotalRecordCount, 2);
    assert.deepEqual((await getTvShowsApi(api).getEpisodes({ seriesId: id(series), season: 99 })).data.Items, []);
    assert.equal((await getLiveTvApi(api).getLiveTvInfo()).data.IsEnabled, true);
    const channels = (await getLiveTvApi(api).getLiveTvChannels()).data;
    assert.equal(channels.TotalRecordCount, 1); assert.equal(channels.Items[0].Id, id(channel));
    const now = Date.now(), addEvent = (sourceId, key, start) => graph.sql("INSERT INTO EPGEvents(source_id,channel_id,source_key,title,starts_at,ends_at) VALUES(?,?,?,?,?,?)").run(sourceId, channel, key, "Owned programme", start, start + 3600000);
    addEvent("owned", "now", now - 1800000); addEvent("owned", "next", now + 1800000); addEvent("excluded", "excluded", now);
    const guide = (await getLiveTvApi(api).getLiveTvPrograms({ channelIds: [id(channel)], limit: 1 })).data;
    assert.equal(guide.TotalRecordCount, 2); assert.equal(guide.Items.length, 1); assert.equal(guide.Items[0].ChannelId, id(channel));
    assert.deepEqual((await getLiveTvApi(api).getProgram({ programId: guide.Items[0].Id })).data, guide.Items[0]);
    assert.equal((await getLiveTvApi(api).getLiveTvPrograms({ channelIds: [id(channel)], minStartDate: new Date(now).toISOString() })).data.TotalRecordCount, 1);
    await assert.rejects(getLiveTvApi(api).getLiveTvPrograms({ channelIds: [id(excluded)] }), error => error.response?.status === 404);
    await assert.rejects(getLiveTvApi(api).getLiveTvPrograms({ limit: 201 }), error => error.response?.status === 400);
    await assert.rejects(getLiveTvApi(api).getLiveTvPrograms({ minStartDate: new Date(now - 40 * 86400000).toISOString() }), error => error.response?.status === 400);
    assert.equal(resolutions, 0); assert.equal(requests, 0);
    const info = async (value = movie, extra = {}) => (await getMediaInfoApi(api).getPostedPlaybackInfo({ itemId: id(value), playbackInfoDto: { EnableDirectPlay: true, ...extra } })).data;
    let play = await info(); assert.equal(resolutions, 1); assert.equal(requests, 0);
    assert.equal(play.MediaSources.length, 1);
    let stream = play.MediaSources[0];
    assert.equal(stream.SupportsTranscoding, false);
    assert.equal(stream.DirectStreamUrl, `${origin}/movie.mp4`);
    assert.equal(stream.Path, stream.DirectStreamUrl);
    assert.deepEqual(stream.RequiredHttpHeaders, { Authorization: "Bearer upstream-private" });
    assert.deepEqual(Buffer.from(await (await fetch(stream.DirectStreamUrl, { headers: stream.RequiredHttpHeaders })).arrayBuffer()), bytes);
    const ranged = await fetch(stream.DirectStreamUrl, { headers: { ...stream.RequiredHttpHeaders, Range: "bytes=2-7" } });
    assert.equal(ranged.status, 206); assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(2, 8));
    assert.equal((await fetch(stream.DirectStreamUrl, { method: "HEAD", headers: stream.RequiredHttpHeaders })).status, 200);
    const subs = stream.MediaStreams.filter(track => track.Type === "Subtitle");
    assert.equal(await (await fetch(subs[0].DeliveryUrl, { headers: stream.RequiredHttpHeaders })).text(), subtitle);
    assert.match(await (await fetch(subs[1].DeliveryUrl, { headers: stream.RequiredHttpHeaders })).text(), /script/);
    const report = { ItemId: id(movie), PlaySessionId: play.PlaySessionId, PositionTicks: 12000000 };
    await getPlaystateApi(api).reportPlaybackStart({ playbackStartInfo: report });
    await getPlaystateApi(api).reportPlaybackStart({ playbackStartInfo: report });
    await getPlaystateApi(api).reportPlaybackProgress({ playbackProgressInfo: { ...report, PositionTicks: 23000000 } });
    assert.equal((await getUserLibraryApi(api).markFavoriteItem({ itemId: id(movie) })).data.IsFavorite, true);
    assert.equal((await getPlaystateApi(api).markPlayedItem({ itemId: id(movie) })).data.Played, true);
    let state = (await getUserLibraryApi(api).getItem({ itemId: id(movie) })).data.UserData;
    assert.equal(state.PlayCount, 1); assert.equal(state.PlaybackPositionTicks, 23000000); assert.equal(state.IsFavorite, true);
    await assert.rejects(getPlaystateApi(api).reportPlaybackProgress({ playbackProgressInfo: { ...report, PositionTicks: -1 } }), error => error.response?.status === 400);
    await assert.rejects(getPlaystateApi(api).reportPlaybackProgress({ playbackProgressInfo: { ...report, ItemId: id(episode) } }), error => error.response?.status === 401);
    await assert.rejects(info(excluded), error => error.response?.status === 404);
    assert.equal((await info(movie, { EnableDirectPlay: false })).ErrorCode, "NoCompatibleStream");
    assert.equal((await getMediaInfoApi(api).getPostedPlaybackInfo({ itemId: id(movie), enableDirectPlay: false })).data.ErrorCode, "NoCompatibleStream");
    await assert.rejects(getMediaInfoApi(api).getPostedPlaybackInfo({ itemId: id(movie), enableDirectPlay: false, playbackInfoDto: { EnableDirectPlay: true } }), error => error.response?.status === 400);
    assert.equal((await info(movie, { MaxStreamingBitrate: 100 })).MediaSources.length, 0);
    const beforeDenied = requests;
    const fallback = `${credentials.server}/Videos/${id(movie)}/stream?Static=true&MediaSourceId=${"0".repeat(32)}&PlaySessionId=${play.PlaySessionId}&api_key=${session.AccessToken}`;
    assert.equal((await fetch(fallback, { redirect: "manual" })).status, 403); assert.equal(requests, beforeDenied);
    await getPlaystateApi(api).reportPlaybackStopped({ playbackStopInfo: { ...report, PositionTicks: 30000000 } });
    assert.equal((await fetch(stream.DirectStreamUrl, { headers: stream.RequiredHttpHeaders })).status, 200, "BOSS cannot revoke an upstream URL already handed to a player");
    assert.equal((await fetch(subs[0].DeliveryUrl, { headers: stream.RequiredHttpHeaders })).status, 200);
    assert.equal(graph.sql("SELECT count(*) n FROM PlaybackEvidence").get().n, 0, "Client reports are not verified playback evidence");
    for (const value of [episode, channel]) {
      const response = await info(value);
      const resource = response.MediaSources[0];
      assert.deepEqual(Buffer.from(await (await fetch(resource.DirectStreamUrl, { headers: resource.RequiredHttpHeaders })).arrayBuffer()), bytes);
    }
    mode = "m3u8"; play = await info(); stream = play.MediaSources[0];
    const playlist = await (await fetch(stream.DirectStreamUrl, { headers: stream.RequiredHttpHeaders })).text();
    const segment = playlist.split("\n").find(line => line.startsWith("http"));
    assert.equal(segment, undefined); assert.match(playlist, /segment\.ts/);
    assert.deepEqual(Buffer.from(await (await fetch(new URL("segment.ts", stream.DirectStreamUrl), { headers: stream.RequiredHttpHeaders })).arrayBuffer()), bytes);
    await getSessionApi(api).reportSessionEnded();
    const beforeRevoked = requests;
    for (const url of [stream.DirectStreamUrl, stream.MediaStreams.find(track => track.Type === "Subtitle").DeliveryUrl]) assert.equal((await fetch(url, { headers: stream.RequiredHttpHeaders })).status, 200);
    assert.ok(requests > beforeRevoked, "Direct provider requests remain outside BOSS session revocation");
    session = await login(); api = sdk.createApi(credentials.server, session.AccessToken);
    state = (await getUserLibraryApi(api).getItem({ itemId: id(movie) })).data.UserData;
    assert.equal(state.PlaybackPositionTicks, 30000000); assert.equal(state.IsFavorite, true);
    mode = "slow"; play = await info();
    const slowSource = play.MediaSources[0];
    const slow = await fetch(slowSource.DirectStreamUrl, { headers: slowSource.RequiredHttpHeaders });
    const completed = slow.arrayBuffer();
    await getSessionApi(api).reportSessionEnded(); releaseSlow();
    assert.deepEqual(Buffer.from(await completed), bytes, "BOSS logout cannot interrupt direct provider playback");
    session = await login(); api = sdk.createApi(credentials.server, session.AccessToken);
    mode = "mp4"; play = await info();
    graph.updateSource("owned", { name: "Changed" });
    assert.equal((await fetch(play.MediaSources[0].DirectStreamUrl, { headers: play.MediaSources[0].RequiredHttpHeaders })).status, 200);
    assert.equal(graph.sql("SELECT count(*) n FROM OutputUserData").get().n, 1);
  } finally {
    releaseSlow?.();
    if (runtime) { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); await runtime.close(); }
    if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

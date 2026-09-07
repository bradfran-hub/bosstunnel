"use strict";
const { jsonArray } = require("./library");
const { createHash } = require("node:crypto");
function createXtreamOutput(library, credentials) {
  const sid = (media) => library.engine.synthetic("xtream", media.id);
  const play = (media) => `${credentials.server}/${media.type === "channel" ? "live" : media.type === "episode" ? "series" : "movie"}/${credentials.username}/${credentials.password}/${sid(media)}.${library.playbackExtension(media)}`;
  const categoryId = (media) => {
    const row = library.graph.sql("SELECT c.id FROM Categories c JOIN MediaCategories mc ON mc.category_id=c.id WHERE mc.media_id=? AND c.source_id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM SourceMappings sm WHERE sm.media_id=mc.media_id AND sm.source_id=c.source_id AND sm.active=1) ORDER BY c.id LIMIT 1").get(media.id, JSON.stringify(library.collection.sourceIds));
    return row ? String(row.id + 1) : "1";
  };
  const film = (media) => { const days = library.archiveDays(media); return ({ num: sid(media), name: media.title, stream_type: media.type === "channel" ? "live" : "movie", stream_id: sid(media), stream_icon: library.artwork(media).poster || library.artwork(media).logo || "", category_id: categoryId(media), container_extension: library.playbackExtension(media), direct_source: play(media), added: String(Math.floor(media.updatedAt / 1000)), epg_channel_id: media.type === "channel" ? String(sid(media)) : null, tv_archive: days > 0 ? 1 : 0, tv_archive_duration: days }); };
  const show = (media) => ({ num: sid(media), series_id: sid(media), name: media.title, cover: library.artwork(media).poster || "", plot: media.description || "", category_id: categoryId(media), rating: String(media.rating || 0), last_modified: String(Math.floor(media.updatedAt / 1000)) });
  async function* filtered(type, category) {
    if (category && (!/^[1-9]\d*$/.test(category) || !Number.isSafeInteger(Number(category)))) return;
    yield* library.items({ types: [type], ...(category ? { categoryId: Number(category) - 1 } : {}) });
  }
  async function* render(params) {
    library.collection;
    const action = params.get("action") || "";
    if (!action || action === "get_account_info") {
      const url = new URL(credentials.server);
      yield JSON.stringify({ user_info: { username: credentials.username, password: credentials.password, auth: 1, status: "Active", exp_date: null, is_trial: "0", active_cons: "0", max_connections: "0", allowed_output_formats: ["ts", "m3u8"] }, server_info: { url: url.hostname, port: url.port || (url.protocol === "https:" ? "443" : "80"), https_port: url.port || "443", server_protocol: url.protocol.slice(0, -1), timezone: "UTC", timestamp_now: Math.floor(Date.now() / 1000), time_now: new Date().toISOString() } }); return;
    }
    const kind = { get_live_categories: "channel", get_vod_categories: "movie", get_series_categories: "series" }[action];
    if (kind) {
      const rows = library.graph.sql("SELECT c.id,c.name,c.source_id,s.protocol FROM Categories c JOIN Sources s ON s.id=c.source_id WHERE c.kind=? AND c.source_id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM MediaCategories mc JOIN SourceMappings sm ON sm.media_id=mc.media_id AND sm.source_id=c.source_id WHERE mc.category_id=c.id AND sm.active=1) ORDER BY c.id").iterate(kind, JSON.stringify(library.collection.sourceIds));
      yield '[{"category_id":"1","category_name":"Boss Media","parent_id":0}';
      for (const row of rows) {
        library.collection;
        const sourceName = library.graph.source(row.source_id).name;
        yield `,${JSON.stringify({ category_id: String(row.id + 1), category_name: ["other", "catalogue", "boss"].includes(row.protocol) ? `${sourceName} | ${row.name}` : row.name, parent_id: 0 })}`;
      }
      yield "]"; return;
    }
    if (["get_live_streams", "get_vod_streams", "get_series"].includes(action)) {
      const category = params.get("category_id");
      const renderItem = action === "get_series" ? show : film;
      yield* jsonArray(filtered({ get_live_streams: "channel", get_vod_streams: "movie", get_series: "series" }[action], category), (media) => ({ ...renderItem(media), ...(category ? { category_id: category } : {}) })); return;
    }
    if (action === "get_vod_info") {
      const media = await library.metadata(library.synthetic(params.get("vod_id")));
      if (media.type !== "movie") throw Object.assign(new Error("Movie not found"), { status: 404 });
      yield JSON.stringify({ info: { name: media.title, movie_image: library.artwork(media).poster || "", plot: media.description || "", duration_secs: media.runtimeSeconds || 0, rating: media.rating || 0 }, movie_data: film(media) }); return;
    }
    if (action === "get_series_info") {
      const series = await library.metadata(library.synthetic(params.get("series_id")));
      if (series.type !== "series") throw Object.assign(new Error("Series not found"), { status: 404 });
      const seasons = library.graph.sql("SELECT DISTINCT season_number FROM Episodes WHERE series_id=? ORDER BY season_number").all(series.id);
      yield `{"info":${JSON.stringify(show(series))},"seasons":${JSON.stringify(seasons.map((row) => ({ season_number: row.season_number, name: `Season ${row.season_number}` })))},"episodes":{`;
      let first = true;
      for (const season of seasons) {
        if (!first) yield ","; first = false;
        yield `${JSON.stringify(String(season.season_number))}:`;
        async function* episodes() { for await (const media of library.items({ types: ["episode"], seriesId: series.id })) if (media.seasonNumber === season.season_number) yield media; }
        yield* jsonArray(episodes(), (episode) => ({ id: String(sid(episode)), episode_num: episode.episodeNumber, season: episode.seasonNumber, title: episode.title, container_extension: library.playbackExtension(episode), direct_source: play(episode), info: { plot: episode.description || "", duration_secs: episode.runtimeSeconds || 0 } }));
      }
      yield "}}"; return;
    }
    if (["get_short_epg", "get_simple_data_table"].includes(action)) {
      const media = library.synthetic(params.get("stream_id"));
      if (media.type !== "channel") throw Object.assign(new Error("Channel not found"), { status: 404 });
      const events = library.graph.sql("SELECT * FROM EPGEvents WHERE channel_id=? AND ends_at>? AND source_id IN (SELECT value FROM json_each(?)) ORDER BY starts_at LIMIT ?").all(media.id, Date.now(), JSON.stringify(library.collection.sourceIds), Math.max(1, Math.min(Number(params.get("limit")) || 20, 200)));
      yield JSON.stringify({ epg_listings: events.map((event) => ({ id: String(event.id), epg_id: String(event.id), channel_id: String(sid(media)), title: Buffer.from(event.title).toString("base64"), description: Buffer.from(event.description || "").toString("base64"), start: new Date(event.starts_at).toISOString(), end: new Date(event.ends_at).toISOString(), start_timestamp: String(event.starts_at / 1000), stop_timestamp: String(event.ends_at / 1000) })) }); return;
    }
    throw Object.assign(new Error("Unsupported player action"), { status: 400 });
  }
  return { render, play, media: (id, kind) => { const media = library.synthetic(id); if (media.type !== { movie: "movie", series: "episode", live: "channel" }[kind]) throw Object.assign(new Error("Media type mismatch"), { status: 404 }); return media; } };
}
module.exports = { createXtreamOutput };

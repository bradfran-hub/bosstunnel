"use strict";
const { OutputAuth } = require("../core/output-auth");
const { AuthLimit } = require("../core/auth-limit");
const { createJellyfinOutput, canonicalId } = require("./jellyfin");
const { OutputState } = require("../core/output-state");
const { createJellyfinPlayback } = require("./jellyfin-playback");
const { createJellyfinLive } = require("./jellyfin-live");
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function authorization(req, url) {
  const header = name => {
    if ((req.rawHeaders || []).filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length > 1) throw fail("Ambiguous authorization", 401);
    const value = req.headers[name];
    if (value != null && typeof value !== "string") throw fail("Invalid authorization", 401);
    return value;
  };
  const ordinary = header("authorization"), emby = header("x-emby-authorization");
  if (ordinary && emby) throw fail("Ambiguous authorization", 401);
  const fields = Object.create(null), input = ordinary || emby;
  if (input) {
    if (input.length > 4096 || !/^MediaBrowser\s+/i.test(input)) throw fail("Invalid authorization", 401);
    const text = input.replace(/^MediaBrowser\s+/i, "");
    const part = /\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"((?:[^"\\\r\n]|\\[\x20-\x7e])*)"\s*(?:,|$)/gy;
    let position = 0, count = 0;
    if (!text || /,\s*$/.test(text)) throw fail("Invalid authorization", 401);
    while (position < text.length) {
      const match = part.exec(text);
      if (!match || ++count > 16) throw fail("Invalid authorization", 401);
      const key = match[1].toLowerCase(), value = match[2].replace(/\\(.)/g, "$1");
      if (Object.hasOwn(fields, key) || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw fail("Invalid authorization", 401);
      fields[key] = value; position = part.lastIndex;
    }
  }
  const query = url.searchParams.getAll("api_key");
  if (query.length > 1) throw fail("Ambiguous authorization", 401);
  const tokens = [fields.token, header("x-emby-token"), query[0]].filter(value => value !== undefined);
  if (tokens.length > 1) throw fail("Ambiguous authorization", 401);
  return { token: tokens[0], deviceId: fields.deviceid };
}

function createJellyfinHttp({ graph, library, json, body, handoff, serverId, baseUrl }) {
  const auth = new OutputAuth(graph), attempts = new AuthLimit({ clock: graph.clock });
  const state = new OutputState(graph, auth, "jellyfin");
  const playback = createJellyfinPlayback({ graph, auth, state, library, handoff, baseUrl });
  const user = session => ({ Id: session.userId, Name: session.name, ServerId: serverId, HasPassword: true, HasConfiguredPassword: true, Policy: { IsAdministrator: false, IsDisabled: false, EnableContentDeletion: false, EnableMediaPlayback: library(session.collectionId).capabilities.streams, EnableVideoPlaybackTranscoding: false, EnableAudioPlaybackTranscoding: false } });
  const system = () => ({ Id: serverId, ServerName: "Boss Media Servers", ProductName: "Boss Media Servers", Version: require("../package.json").version, LocalAddress: baseUrl, StartupWizardCompleted: true });
  async function handle(req, res, url, rest) {
    const resource = rest.match(/^\/Resources\/([A-Za-z0-9_-]{1,12000})$/);
    if (resource) {
      if (!["GET", "HEAD"].includes(req.method)) throw fail("Method not allowed", 405);
      if (url.search) throw fail("Unexpected resource parameters");
      return playback.resource(req, res, resource[1]);
    }
    if (["/System/Info/Public", "/Users/Public"].includes(rest)) {
      if (req.method !== "GET") throw fail("Method not allowed", 405);
      return json(res, 200, rest === "/Users/Public" ? [] : system());
    }
    if (rest === "/Users/AuthenticateByName") {
      if (req.method !== "POST") throw fail("Method not allowed", 405);
      const peer = req.socket.remoteAddress || "unknown", retry = attempts.check(peer);
      if (retry) throw Object.assign(fail("Too many authentication attempts", 429), { retryAfter: retry });
      try {
        const identity = authorization(req, url), input = await body(req);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Invalid login request", 401);
        const session = auth.authenticate("jellyfin", input.Username, input.Pw, { deviceId: identity.deviceId });
        attempts.succeeded(peer);
        return json(res, 200, { User: user(session), AccessToken: session.token, ServerId: serverId });
      } catch (error) { attempts.failed(peer); throw error; }
    }
    const identity = authorization(req, url), session = auth.verify("jellyfin", identity.token);
    if (rest === "/Sessions/Logout") {
      if (req.method !== "POST") throw fail("Method not allowed", 405);
      auth.revoke("jellyfin", identity.token); return json(res, 204, null);
    }
    const imagePath = rest.match(/^\/Items\/([a-f0-9]{32})\/Images\/(Primary|Backdrop|Logo|Thumb)(?:\/(\d+))?$/i);
    const params = Object.create(null);
    for (const [key, value] of url.searchParams) {
      const name = key.toLowerCase();
      if (Object.hasOwn(params, name)) throw fail("Duplicate query parameter");
      params[name] = value;
    }
    if (params.userid && params.userid !== session.userId) throw fail("User access denied", 403);
    const lib = library(session.collectionId);
    const playbackInfo = rest.match(/^\/Items\/([a-f0-9]{32})\/PlaybackInfo$/i);
    if (playbackInfo) {
      if (!["GET", "POST"].includes(req.method)) throw fail("Method not allowed", 405);
      const booleanFields = ["AutoOpenLiveStream", "EnableDirectPlay", "EnableDirectStream", "EnableTranscoding", "AllowVideoStreamCopy", "AllowAudioStreamCopy"];
      const allowed = ["userid", "api_key", "starttimeticks", "maxstreamingbitrate", "maxaudiochannels", "audiostreamindex", "subtitlestreamindex", "mediasourceid", "livestreamid", "isplayback", ...booleanFields.map(key => key.toLowerCase())];
      if (Object.keys(params).some(key => !allowed.includes(key))) throw fail("Unsupported playback query", 422);
      const empty = !req.headers["transfer-encoding"] && (!req.headers["content-length"] || req.headers["content-length"] === "0");
      const input = req.method === "POST" && !empty ? await body(req) : {};
      if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Invalid playback request");
      for (const key of ["StartTimeTicks", "MaxStreamingBitrate", "MaxAudioChannels", "AudioStreamIndex", "SubtitleStreamIndex"]) if (params[key.toLowerCase()] !== undefined) {
        const value = params[key.toLowerCase()];
        if (!/^-?\d+$/.test(value) || input[key] !== undefined && input[key] !== Number(value)) throw fail("Ambiguous playback option");
        input[key] = Number(value);
      }
      for (const key of ["MediaSourceId", "LiveStreamId"]) if (input[key] || params[key.toLowerCase()]) throw fail("Request fresh playback information without a source selector", 422);
      for (const key of booleanFields) if (params[key.toLowerCase()] !== undefined) {
        const value = params[key.toLowerCase()];
        if (!["true", "false"].includes(value) || input[key] !== undefined && input[key] !== (value === "true")) throw fail("Ambiguous playback option");
        input[key] = value === "true";
      }
      if (params.isplayback !== undefined && !["true", "false"].includes(params.isplayback)) throw fail("Invalid playback option");
      return json(res, 200, await playback.info(identity.token, playbackInfo[1], input));
    }
    const stream = rest.match(/^\/Videos\/([a-f0-9]{32})\/stream(?:\.[a-z0-9]+)?$/i);
    if (stream) {
      if (!["GET", "HEAD"].includes(req.method)) throw fail("Method not allowed", 405);
      const allowed = ["static", "mediasourceid", "playsessionid", "api_key", "userid", "deviceid", "tag"];
      if (Object.keys(params).some(key => !allowed.includes(key))) throw fail("Unsupported stream transformation", 422);
      return playback.stream(req, res, identity.token, stream[1], params);
    }
    const report = { "/Sessions/Playing": "start", "/Sessions/Playing/Progress": "progress", "/Sessions/Playing/Stopped": "stop" }[rest];
    if (report) {
      if (req.method !== "POST") throw fail("Method not allowed", 405);
      const input = await body(req);
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.PlaySessionId !== "string") throw fail("Invalid playback report");
      if (input.UserId && input.UserId !== session.userId) throw fail("User access denied", 403);
      const media = lib.media(canonicalId(input.ItemId));
      state.report(identity.token, input.PlaySessionId, media, report, input.PositionTicks);
      return json(res, 204, null);
    }
    const flag = rest.match(/^\/User(Favorite|Played)Items\/([a-f0-9]{32})$/i);
    if (flag) {
      if (!["POST", "DELETE"].includes(req.method)) throw fail("Method not allowed", 405);
      if (Object.keys(params).some(key => !["userid", "api_key"].includes(key))) throw fail("Unsupported user data option", 422);
      const media = lib.media(canonicalId(flag[2]));
      return json(res, 200, state.update(session, media, { [flag[1].toLowerCase() === "favorite" ? "IsFavorite" : "Played"]: req.method === "POST" }));
    }
    if (req.method !== "GET" && !(req.method === "HEAD" && imagePath)) throw fail("Method not allowed", 405);
    if (rest === "/System/Info") return json(res, 200, system());
    if (rest === "/Users/Me" || rest === `/Users/${session.userId}`) return json(res, 200, user(session));
    const scoped = rest.match(/^\/Users\/([a-f0-9]{32})(\/Items(?:\/[a-f0-9]{32})?)$/i);
    if (scoped) {
      if (scoped[1].toLowerCase() !== session.userId) throw fail("User access denied", 403);
      rest = scoped[2];
    }
    const output = await createJellyfinOutput(lib);
    const userData = item => item.Type === "CollectionFolder" ? item : { ...item, UserData: state.read(session, lib.media(canonicalId(item.Id))) };
    const integer = (key, fallback) => {
      if (params[key] === undefined) return fallback;
      if (!/^\d+$/.test(params[key]) || !Number.isSafeInteger(Number(params[key]))) throw fail("Invalid pagination or season number");
      return Number(params[key]);
    };
    const navigation = rest.match(/^\/Shows\/([a-f0-9]{32})\/(Seasons|Episodes)$/i);
    if (navigation) {
      if (Object.keys(params).some(key => !["userid", "api_key", "startindex", "limit", "season", "seasonid"].includes(key))) throw fail("Unsupported series query", 422);
      const series = lib.media(canonicalId(navigation[1]));
      if (series.type !== "series") throw fail("Series navigation requires a series", 422);
      await lib.metadata(series); auth.verify("jellyfin", identity.token);
      const episodes = navigation[2].toLowerCase() === "episodes";
      let parentId = navigation[1];
      if (!episodes && (params.season !== undefined || params.seasonid !== undefined)) throw fail("Season selectors require episode navigation");
      if (params.seasonid !== undefined) {
        const season = lib.media(canonicalId(params.seasonid));
        if (season.type !== "season" || season.seriesId !== series.id || params.season !== undefined && integer("season") !== season.seasonNumber) throw fail("Season is outside this series", 404);
        parentId = params.seasonid;
      } else if (params.season !== undefined) {
        const season = graph.sql("SELECT media_id FROM Seasons WHERE series_id=? AND number=?").get(series.id, integer("season"));
        if (!season) return json(res, 200, { Items: [], TotalRecordCount: 0, StartIndex: integer("startindex", 0) });
        parentId = lib.media(season.media_id).canonicalId.replaceAll("-", "");
      }
      const result = await output.items({ parentId, includeItemTypes: [episodes ? "Episode" : "Season"], startIndex: integer("startindex", 0), limit: integer("limit", 100), order: episodes ? "episode" : "season" });
      auth.verify("jellyfin", identity.token);
      return json(res, 200, { ...result, Items: result.Items.map(userData) });
    }
    if (rest === "/LiveTv/Info") {
      const enabled = lib.count({ types: ["channel"] }) > 0;
      return json(res, 200, { IsEnabled: enabled, EnabledUsers: enabled ? [session.userId] : [], Services: [] });
    }
    if (rest === "/LiveTv/Channels") {
      if (Object.keys(params).some(key => !["userid", "api_key", "startindex", "limit"].includes(key))) throw fail("Unsupported channel query", 422);
      const result = await output.items({ includeItemTypes: ["TvChannel"], startIndex: integer("startindex", 0), limit: integer("limit", 100) });
      auth.verify("jellyfin", identity.token);
      return json(res, 200, { ...result, Items: result.Items.map(userData) });
    }
    const channel = rest.match(/^\/LiveTv\/Channels\/([a-f0-9]{32})$/i);
    if (channel) {
      const media = lib.media(canonicalId(channel[1]));
      if (media.type !== "channel") throw fail("Channel not found", 404);
      return json(res, 200, userData(output.record(media)));
    }
    if (rest === "/LiveTv/Programs") return json(res, 200, createJellyfinLive(lib).programs(params));
    const program = rest.match(/^\/LiveTv\/Programs\/([a-f0-9]{32})$/i);
    if (program) return json(res, 200, createJellyfinLive(lib).program(program[1]));
    if (imagePath) {
      if (Object.keys(params).some(key => !["userid", "api_key", "tag", "imageindex", "maxwidth", "maxheight"].includes(key))) throw fail("Unsupported image transformation", 422);
      for (const key of ["maxwidth", "maxheight"]) if (params[key] !== undefined && (!/^\d+$/.test(params[key]) || Number(params[key]) < 1 || Number(params[key]) > 16384)) throw fail("Invalid image size hint");
      if (imagePath[3] !== undefined && params.imageindex !== undefined) throw fail("Ambiguous image index");
      const index = imagePath[3] ?? params.imageindex ?? "0";
      if (!/^\d+$/.test(index)) throw fail("Invalid image index");
      const type = ["Primary", "Backdrop", "Logo", "Thumb"].find(value => value.toLowerCase() === imagePath[2].toLowerCase());
      const resource = output.image(imagePath[1], type, Number(index));
      return handoff(req, res, lib, resource.sourceId, resource.resource, session.expiresAt, false, { authorize: () => auth.verify("jellyfin", identity.token) });
    }
    const viewPath = rest.match(/^\/Users\/([a-f0-9]{32})\/Views$/i);
    if (rest === "/UserViews" || viewPath) {
      if (viewPath && viewPath[1].toLowerCase() !== session.userId) throw fail("User access denied", 403);
      if (Object.keys(params).some(key => !["userid", "api_key", "includeexternalcontent", "includehidden"].includes(key))) throw fail("Unsupported view query", 422);
      for (const key of ["includeexternalcontent", "includehidden"]) if (params[key] !== undefined && !["true", "false"].includes(params[key])) throw fail("Invalid view option");
      const result = output.views(); auth.verify("jellyfin", identity.token);
      return json(res, 200, result);
    }
    if (rest === "/Items") {
      const allowed = ["startindex", "limit", "includeitemtypes", "searchterm", "parentid", "enabletotalrecordcount", "userid", "api_key"];
      if (Object.keys(params).some(key => !allowed.includes(key))) throw fail("Unsupported catalogue query", 422);
      if (params.enabletotalrecordcount !== undefined && !["true", "false"].includes(params.enabletotalrecordcount)) throw fail("Invalid count option");
      const result = await output.items({ startIndex: integer("startindex", 0), limit: integer("limit", 100), includeItemTypes: params.includeitemtypes?.split(","), searchTerm: params.searchterm || "", parentId: params.parentid, enableTotalRecordCount: params.enabletotalrecordcount !== "false" });
      auth.verify("jellyfin", identity.token);
      return json(res, 200, { ...result, Items: result.Items.map(userData) });
    }
    const item = rest.match(/^\/Items\/([a-f0-9]{32})$/i);
    if (item) {
      const result = await output.item(item[1]); auth.verify("jellyfin", identity.token);
      return json(res, 200, userData(result));
    }
    throw fail("Jellyfin operation is not implemented", 404);
  }
  return { handle, auth, state };
}

module.exports = { createJellyfinHttp, authorization };

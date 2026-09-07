"use strict";
const crypto = require("node:crypto");
const { canonicalId, itemId } = require("./jellyfin");
const { playbackRequest, directPlayable } = require("./media-server-profile");
const { httpMedia } = require("../stream-policy");
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const codec = value => String(value || "").toLowerCase();
function createJellyfinPlayback({ graph, auth, state, library, handoff, baseUrl, protocol = "jellyfin" }) {
  const resourceId = candidate => crypto.createHmac("sha256", graph.secrets.key).update(JSON.stringify([candidate.sourceId, candidate.resource.url, candidate.requiredHeaders])).digest("hex").slice(0, 32);
  function current(token, playId, mediaId, sourceId, revision) {
    const session = auth.verify(protocol, token), lib = library(session.collectionId), media = lib.media(mediaId);
    const { play } = state.verify(token, playId, media);
    if (sourceId && (!lib.collection.sourceIds.includes(sourceId) || graph.source(sourceId)?.revision !== revision)) throw fail("Playback source was revoked", 403);
    return { session, lib, media, play };
  }
  function ticket(data, resource, expiresAt) {
    if (!httpMedia(resource.url)) throw fail("Unsupported media resource", 422);
    const sealed = Buffer.from(graph.secrets.seal({ ...data, resource, expiresAt })).toString("base64url");
    if (sealed.length > 12000) throw fail("Media resource exceeds output URL limit", 422);
    return `${baseUrl}/Resources/${sealed}`;
  }
  async function resource(req, res, value) {
    let data;
    try { data = graph.secrets.open(Buffer.from(value, "base64url").toString()); } catch { throw fail("Invalid media resource", 403); }
    if (data.protocol !== protocol || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= graph.clock()) throw fail("Media resource expired", 403);
    const { lib } = current(data.token, data.playId, data.mediaId, data.sourceId, data.revision);
    return handoff(req, res, lib, data.sourceId, data.resource, data.expiresAt, data.mediaPlayback, {
      ...(!data.mediaPlayback ? { maxBodyBytes: 8 * 1024 * 1024, allowedContentTypes: ["text/plain", "text/vtt", "application/x-subrip", "application/octet-stream", "text/x-ssa", "text/x-ass"] } : {}),
      authorize: () => current(data.token, data.playId, data.mediaId, data.sourceId, data.revision), authorizeEachChunk: true,
      resourceLink: child => ticket(data, child, data.expiresAt)
    });
  }
  async function info(token, id, input = {}) {
    playbackRequest(input);
    const session = auth.verify(protocol, token), lib = library(session.collectionId), media = lib.media(canonicalId(id));
    if (input.UserId && input.UserId !== session.userId) throw fail("User access denied", 403);
    if (!["movie", "episode", "channel", "event"].includes(media.type)) throw fail("Item is not playable", 422);
    let resolved;
    try { resolved = await lib.resolve(media, { output: protocol, protocols: ["http", "hls"] }); }
    catch (error) {
      auth.verify(protocol, token);
      if (error.status === 422) return { MediaSources: [], ErrorCode: "NoCompatibleStream" };
      throw error;
    }
    auth.verify(protocol, token);
    const candidates = resolved.candidates.filter(candidate => directPlayable(candidate, input)).slice(0, 8);
    if (!candidates.length) return { MediaSources: [], ErrorCode: "NoCompatibleStream" };
    let resources = candidates.map(candidate => ({ ...candidate, id: resourceId(candidate), revision: graph.source(candidate.sourceId).revision }));
    let subtitles = [];
    if (!input.DeviceProfile?.SubtitleProfiles || input.DeviceProfile.SubtitleProfiles.some(profile => profile.Method === "External")) {
      const signal = AbortSignal.timeout(4000);
      try { subtitles = await lib.subtitles(media, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
    auth.verify(protocol, token);
    resources = resources.filter(candidate => graph.source(candidate.sourceId)?.revision === candidate.revision && (!candidate.expiresAt || candidate.expiresAt > graph.clock() + 1000));
    if (!resources.length) return { MediaSources: [], ErrorCode: "NoCompatibleStream" };
    const play = state.create(token, media, resources);
    const MediaSources = resources.map(candidate => {
      const data = { protocol, token, playId: play.id, mediaId: media.id, sourceId: candidate.sourceId, revision: candidate.revision, mediaPlayback: true };
      const expiresAt = Math.min(play.expiresAt, candidate.expiresAt || play.expiresAt);
      const MediaStreams = [];
      if (candidate.codec || candidate.resolution) MediaStreams.push({ Type: "Video", ...(candidate.codec ? { Codec: candidate.codec } : {}), ...(candidate.resolution?.width ? { Width: candidate.resolution.width } : {}), ...(candidate.resolution?.height ? { Height: candidate.resolution.height } : {}) });
      for (const audio of candidate.audio) MediaStreams.push({ Type: "Audio", ...(audio.codec ? { Codec: audio.codec } : {}), ...(audio.language ? { Language: audio.language } : {}), ...(audio.channels ? { Channels: audio.channels } : {}), ...(Number.isInteger(audio.index) ? { Index: audio.index } : {}) });
      for (const [index, subtitle] of subtitles.entries()) {
        const extension = new URL(subtitle.resource.url).pathname.match(/\.(srt|vtt|ass|ssa)$/i)?.[1]?.toLowerCase();
        if (!extension) continue;
        const profiles = input.DeviceProfile?.SubtitleProfiles;
        if (profiles && !profiles.some(entry => codec(entry.Format) === extension && entry.Method === "External")) continue;
        MediaStreams.push({ Type: "Subtitle", Index: 10000 + index, Codec: extension, Language: subtitle.language, IsExternal: true, DeliveryMethod: "External", DeliveryUrl: subtitle.resource.url, IsExternalUrl: true, IsTextSubtitleStream: true, SupportsExternalStream: true });
      }
      return { Id: candidate.id, Name: media.title, Protocol: "Http", Type: "Default", Path: candidate.resource.url, DirectStreamUrl: candidate.resource.url,
        ...(candidate.container ? { Container: candidate.container } : {}), ...(candidate.bitrate ? { Bitrate: candidate.bitrate } : {}),
        ...(media.runtimeSeconds ? { RunTimeTicks: Math.round(media.runtimeSeconds * 10000000) } : {}),
        SupportsDirectPlay: true, SupportsDirectStream: false, SupportsTranscoding: false, RequiresOpening: false, RequiresClosing: false,
        IsRemote: true, IsInfiniteStream: ["channel", "event"].includes(media.type), MediaStreams, RequiredHttpHeaders: { ...candidate.requiredHeaders } };
    });
    return { MediaSources, PlaySessionId: play.id };
  }
  async function stream(req, res, token, id, params) {
    if (params.static !== "true") throw fail("Only original-file playback is supported", 422);
    if (!params.playsessionid || !params.mediasourceid) throw fail("Playback information is required", 422);
    const { lib, media, play } = current(token, params.playsessionid, canonicalId(id));
    const resources = state.resources(token, play.id, media), candidate = resources.find(value => value.id === params.mediasourceid);
    if (!candidate) throw fail("Media source does not belong to this playback", 403);
    current(token, play.id, media.id, candidate.sourceId, candidate.revision);
    if (candidate.expiresAt && candidate.expiresAt <= graph.clock()) throw fail("Playback information has expired; request fresh playback information", 409);
    const expiresAt = Math.min(play.expires_at, candidate.expiresAt || play.expires_at);
    const data = { protocol, token, playId: play.id, mediaId: media.id, sourceId: candidate.sourceId, revision: candidate.revision, mediaPlayback: true };
    return handoff(req, res, lib, candidate.sourceId, { url: candidate.resource.url, headers: candidate.requiredHeaders }, expiresAt, true, {
      authorize: () => current(token, play.id, media.id, candidate.sourceId, candidate.revision), authorizeEachChunk: true,
      resourceLink: child => ticket(data, child, expiresAt)
    });
  }
  return { info, stream, resource };
}
module.exports = { createJellyfinPlayback };

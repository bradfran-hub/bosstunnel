"use strict";
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { httpMedia, assertMediaResponse } = require("./stream-policy");
const { PlaybackBackoff } = require("./core/playback-backoff");
const playbackBackoff = new PlaybackBackoff();
const failure = (message) => Object.assign(new Error(message), { status: 422 });
async function proxyStream(req, res, stream, childUrl, options = {}) {
  let target = stream.url;
  const scope = options.rateLimitScope || "default";
  playbackBackoff.check(scope, target);
  let headers = { ...(stream.behaviorHints?.proxyHeaders?.request || {}) };
  for (const key of Object.keys(headers)) if (!["authorization", "referer", "user-agent", "origin", "x-emby-token", "x-emby-authorization", "x-plex-token", "x-plex-client-identifier", "x-plex-product", "x-plex-version"].includes(key.toLowerCase())) delete headers[key];
  if (req.headers.range) headers.Range = req.headers.range;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const disconnected = () => controller.abort();
  res.once("close", disconnected);
  let bytes = 0;
  try {
    let response;
    for (let i = 0; i < 6; i++) {
      options.authorize?.();
      if (!httpMedia(target)) throw failure("Torrent or non-HTTP playback is not supported");
      playbackBackoff.check(scope, target);
      response = await fetch(target, { headers, redirect: "manual", signal: controller.signal, method: req.method === "HEAD" ? "HEAD" : "GET" });
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        await response.body?.cancel();
        const error = playbackBackoff.record(scope, target, retryAfter);
        // Remember the entry endpoint too, avoiding another redirect chain during cooldown.
        playbackBackoff.record(scope, stream.url, String(error.retryAfter));
        throw error;
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = new URL(response.headers.get("location"), target).toString();
      await response.body?.cancel();
      if (new URL(next).origin !== new URL(target).origin) headers = req.headers.range ? { Range: req.headers.range } : {};
      target = next;
      if (i === 5) throw failure("Too many playback redirects");
    }
    assertMediaResponse(response);
    if (!response.ok && response.status !== 416) {
      await response.body?.cancel();
      throw Object.assign(failure(`Playback returned HTTP ${response.status}`), { refreshPlayback: [401, 403, 404, 410].includes(response.status) || response.status >= 500 });
    }
    const responseHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range,Content-Length,Accept-Ranges", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    const hls = /mpegurl/i.test(response.headers.get("content-type") || "") || /\.m3u8(?:\?|$)/i.test(target);
    if (options.mediaPlayback && !hls && /^(?:text\/|application\/(?:json|xml))/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel();
      throw failure("Source returned a text document instead of playable media");
    }
    options.authorize?.();
    if (hls && req.method !== "HEAD") {
      const parts = []; let size = 0;
      for await (const part of response.body) { size += part.length; if (size > 2 * 1024 * 1024) throw failure("HLS playlist too large"); parts.push(part); }
      const text = Buffer.concat(parts).toString();
      if (!text.trimStart().startsWith("#EXTM3U")) throw failure("Invalid HLS playlist");
      const link = (relative) => {
        const url = new URL(relative, target).toString();
        if (!httpMedia(url)) throw failure("Unsupported HLS resource");
        return childUrl({ url, behaviorHints: { proxyHeaders: { request: new URL(url).origin === new URL(target).origin ? headers : {} } } });
      };
      const rewritten = text.split(/\r?\n/).map((line) => line.startsWith("#") ? line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${link(uri)}"`) : line.trim() ? link(line.trim()) : line).join("\n");
      res.writeHead(200, { ...responseHeaders, "Content-Type": "application/vnd.apple.mpegurl" }); return res.end(rewritten);
    }
    clearTimeout(timer);
    for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) if (response.headers.has(key)) responseHeaders[key] = response.headers.get(key);
    res.writeHead(response.status, responseHeaders);
    if (req.method === "HEAD" || !response.body) { res.end(); return { bytes: 0, outcome: "probe" }; }
    const counter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(null, chunk); } });
    await pipeline(Readable.from(require("./core/idle-body").idleBody(response.body, controller, options.bodyIdleMs), { objectMode: false }), counter, res);
    return { bytes, outcome: response.ok ? "complete" : "probe" };
  } catch (error) {
    error.bytesDelivered = bytes;
    throw error;
  } finally { clearTimeout(timer); res.off("close", disconnected); controller.abort(); }
}
module.exports = { proxyStream };

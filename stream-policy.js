"use strict";

function httpMedia(value) {
  try {
    const url = new URL(value);
    let decoded = url.href;
    for (let i = 0; i < 3; i++) { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; }
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !/(?:magnet:|urn:btih:|urn:btmh:|\.torrent\b)/i.test(decoded);
  } catch { return false; }
}
function allowedStreams(streams) {
  return (Array.isArray(streams) ? streams : []).filter((s) => s && httpMedia(s.url) && !["infoHash", "info_hash", "magnet", "torrent", "torrentUrl", "sources", "fileIdx"].some((key) => key in s)).map((s) => ({ url: s.url, name: s.name, title: s.title, behaviorHints: { notWebReady: s.behaviorHints?.notWebReady !== false, ...(s.behaviorHints?.proxyHeaders ? { proxyHeaders: s.behaviorHints.proxyHeaders } : {}) } }));
}
function assertMediaResponse(response) {
  if (/bittorrent/i.test(response.headers.get("content-type") || "") || /\.torrent(?:["';\s]|$)/i.test(response.headers.get("content-disposition") || "")) {
    response.body?.cancel();
    throw Object.assign(new Error("Torrent content is not supported"), { status: 422 });
  }
}
module.exports = { httpMedia, allowedStreams, assertMediaResponse };

"use strict";
const { httpMedia } = require("./stream-policy");

function directResource(resource) {
  if (!httpMedia(resource?.url)) throw Object.assign(new Error("Unsupported upstream resource"), { status: 422 });
  return {
    url: resource.url,
    requiredHeaders: { ...(resource.headers || resource.requiredHeaders || {}) },
    headerOrigin: new URL(resource.url).origin,
    delivery: "direct"
  };
}

// A redirect cannot instruct an ordinary IPTV player to add provider headers.
function redirectPlayback(req, res, resource) {
  const direct = directResource(resource);
  if (Object.keys(direct.requiredHeaders).length) throw Object.assign(new Error("This source requires a header-aware player using the BOSS playback API"), { status: 422 });
  res.writeHead(307, {
    Location: direct.url, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff", "Content-Length": "0"
  });
  res.end();
}
module.exports = { directResource, redirectPlayback };

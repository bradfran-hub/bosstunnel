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

// Redirect the exact upstream URL. HTTP cannot carry required request headers;
// header-aware clients should use the native resource contract instead.
function redirectPlayback(req, res, resource) {
  const direct = directResource(resource);
  res.writeHead(307, {
    Location: direct.url, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff", "Content-Length": "0"
  });
  res.end();
}
module.exports = { directResource, redirectPlayback };

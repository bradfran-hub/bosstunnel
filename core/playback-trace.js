"use strict";
const { randomUUID } = require("node:crypto");
function playbackTrace(req, res, kind, mediaId, write = (record) => console.log(JSON.stringify(record))) {
  const started = Date.now();
  const details = { requestId: randomUUID(), kind: ["movie", "series", "live"].includes(kind) ? kind : "media", mediaId: /^\d{1,20}$/.test(String(mediaId)) ? String(mediaId) : null, method: ["GET", "HEAD", "POST"].includes(req.method) ? req.method : "OTHER" };
  let ended = false;
  write({ event: "playback.request", ...details });
  const finish = () => {
    if (ended) return;
    ended = true;
    write({ event: "playback.response", ...details, status: res.statusCode, completed: res.writableFinished, elapsedMs: Date.now() - started });
  };
  res.once("finish", finish); res.once("close", finish);
  return {
    failure(error) {
      const upstream = /^Playback returned HTTP (\d{3})$/.exec(error.message || "");
      write({ event: "playback.candidate_failed", ...details, status: Number.isInteger(error.status) ? error.status : 502, upstreamStatus: error.upstreamStatus === 429 ? 429 : upstream ? Number(upstream[1]) : null, retryable: error.refreshPlayback === true });
    }
  };
}
module.exports = { playbackTrace };

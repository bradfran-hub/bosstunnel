"use strict";

function playbackProtocols(params) {
  if (!params.has("boss_protocols")) return ["http", "hls"];
  const values = params.getAll("boss_protocols");
  const protocols = values[0].split(",");
  if (values.length !== 1 || protocols.length > 3 || new Set(protocols).size !== protocols.length || protocols.some(value => !["http", "hls", "dash"].includes(value))) {
    throw Object.assign(new Error("Invalid playback protocols"), { status: 400 });
  }
  return protocols;
}

module.exports = { playbackProtocols };

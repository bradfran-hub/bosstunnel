"use strict";
const net = require("node:net");
const ipaddr = require("ipaddr.js");
function address(value) {
  if (typeof value !== "string" || value.includes("%") || !net.isIP(value)) return null;
  return ipaddr.process(value).toString();
}
function createClientPeer(configuration = "") {
  const entries = configuration ? configuration.split(",").map(value => value.trim()) : [];
  if (entries.length > 32 || entries.some(value => !address(value))) throw new Error("BOSS_TRUSTED_PROXY_IPS requires at most 32 exact IP addresses");
  const trusted = new Set(entries.map(address));
  return req => {
    const socket = address(req.socket?.remoteAddress) || "unknown";
    // Only a specifically configured immediate proxy may supply this single value.
    if (trusted.has(socket)) {
      const forwarded = address(req.headers["x-boss-client-ip"]);
      if (forwarded) return forwarded;
    }
    return socket;
  };
}
module.exports = { createClientPeer };

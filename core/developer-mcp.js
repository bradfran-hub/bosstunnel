"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod/v4");
const { httpMedia } = require("../stream-policy");

const documents = {
  protocol: ["BOSS-ADDON.md", "BOSS Protocol specification", "text/markdown"],
  app_guide: ["public/sdk.html", "App integration guide", "text/html"],
  addon_guide: ["public/addon-sdk.html", "Addon author guide", "text/html"],
  app_sdk: ["public/boss-client.mjs", "BOSS app SDK source", "text/javascript"],
  addon_sdk: ["public/boss-addon.mjs", "BOSS addon SDK source", "text/javascript"],
  addon_example: ["public/addon-example.mjs", "Standalone addon example", "text/javascript"],
  license: ["LICENSE", "MIT licence", "text/plain"]
};
const docKeys = Object.keys(documents), cache = new Map();
async function document(key) {
  if (!Object.hasOwn(documents, key)) throw new Error("Unknown public document");
  if (!cache.has(key)) {
    const text = await fs.readFile(path.join(__dirname, "..", documents[key][0]), "utf8");
    if (Buffer.byteLength(text) > 131072) throw new Error("Public document exceeds limit");
    cache.set(key, text);
  }
  return cache.get(key);
}
const result = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function validateDescriptor(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { validStructure: false, errors: ["Expected a descriptor object"], playbackVerified: false };
  if (value.format !== "boss-media-addon" || value.version !== 1) errors.push("Expected BOSS descriptor format and version 1");
  if (typeof value.id !== "string" || !value.id.trim() || value.id.length > 256) errors.push("Missing or invalid stable addon ID");
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 1024) errors.push("Missing or invalid addon name");
  let entry;
  try { entry = new URL(value.addonUrl); } catch { errors.push("addonUrl must be an absolute HTTP URL"); }
  if (entry && (!httpMedia(entry.href) || !entry.pathname.endsWith(".boss"))) errors.push("addonUrl must be an authorized HTTP .boss descriptor URL");
  const caps = value.capabilities, resources = value.resources;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) errors.push("Missing capability declaration");
  else {
    for (const key of ["catalog", "metadata", "search", "streams", "subtitles", "live", "epg", "catchup", "timeshift", "categories"]) if (key in caps && typeof caps[key] !== "boolean") errors.push(`${key} capability must be boolean`);
    if (!Array.isArray(caps.types) || caps.types.some(t => !["movie", "series", "season", "episode", "channel", "event"].includes(t))) errors.push("Declare supported media types as an array");
    if ((caps.live || caps.epg || caps.catchup) && (!Array.isArray(caps.types) || !caps.types.includes("channel"))) errors.push("Live, EPG and catch-up capabilities require channel types");
    if (caps.catchup && (!caps.streams || !caps.metadata)) errors.push("Catch-up requires streams and metadata capabilities");
  }
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) errors.push("Missing resources");
  else {
    if (typeof resources.catalogue !== "string") errors.push("A catalogue resource is required for BOSS client discovery");
    for (const [key, capability] of [["catalogue", "catalog"], ["media", "metadata"], ["playback", "streams"], ["subtitles", "subtitles"], ["guide", "epg"], ["categories", "categories"], ["catchup", "catchup"]]) {
      if (caps?.[capability] && typeof resources[key] !== "string") errors.push(`${key} resource is required by its capability`);
    }
    for (const target of Object.values(resources)) {
      try { if (typeof target !== "string" || !httpMedia(target) || !entry || new URL(target).origin !== entry.origin) errors.push("Resource URLs must be HTTP and remain on the addon origin"); }
      catch { errors.push("Invalid resource URL"); }
    }
  }
  if (value.security?.torrents !== false) errors.push("security.torrents must be false");
  return { validStructure: errors.length === 0, errors: [...new Set(errors)], playbackVerified: false, note: "Offline structural checks only; no URLs were fetched. Test authentication, pagination, capability behavior and actual playback separately." };
}

function createDeveloperServer() {
  const server = new McpServer({ name: "boss-protocol", version: "1.0.0" }, {
    instructions: "BOSS is a free MIT-licensed media interchange protocol. Use these public references to integrate apps and addons. Never request private install URLs, source passwords or admin tokens. This MCP has no access to customer libraries and cannot certify playback. Catalogue listing and search must not trigger playback resolution. No torrents, DRM bypass or transcoding."
  });
  server.registerTool("boss_docs", {
    title: "Read BOSS documentation or SDK source", description: "Read an allowlisted public BOSS document in bounded text chunks. Follow nextOffset until null for the full file.", annotations,
    inputSchema: { document: z.enum(docKeys), offset: z.number().int().min(0).max(131072).default(0), limit: z.number().int().min(1).max(16000).default(12000) }
  }, async ({ document: key, offset, limit }) => {
    const text = await document(key), end = Math.min(text.length, offset + limit);
    return result({ document: key, title: documents[key][1], mimeType: documents[key][2], text: text.slice(offset, end), nextOffset: end < text.length ? end : null });
  });
  server.registerTool("boss_search_docs", {
    title: "Search the BOSS protocol references", description: "Literal text search across public protocol documentation and SDK files. Does not search media or private libraries.", annotations,
    inputSchema: { query: z.string().trim().min(2).max(120), limit: z.number().int().min(1).max(20).default(8) }
  }, async ({ query, limit }) => {
    const matches = [], needle = query.toLowerCase();
    for (const key of docKeys) {
      const text = await document(key), lower = text.toLowerCase();
      let at = 0;
      while (matches.length < limit && (at = lower.indexOf(needle, at)) >= 0) { matches.push({ document: key, offset: at, excerpt: text.slice(Math.max(0, at - 100), at + needle.length + 220) }); at += needle.length; }
      if (matches.length === limit) break;
    }
    return result({ matches, truncated: matches.length === limit });
  });
  server.registerTool("boss_validate_descriptor", {
    title: "Validate a public example .boss descriptor", description: "Offline structural checks for a BOSS v1 descriptor. Use sanitized examples only, never submit private install links or credentials. Does not fetch endpoints or claim player compatibility.", annotations,
    inputSchema: { descriptor: z.record(z.string(), z.unknown()) }
  }, ({ descriptor }) => result(validateDescriptor(descriptor)));
  for (const key of docKeys) server.registerResource(key, `boss://docs/${key}`, { title: documents[key][1], mimeType: documents[key][2] }, async uri => ({ contents: [{ uri: uri.href, mimeType: documents[key][2], text: await document(key) }] }));
  server.registerPrompt("integrate_boss", { title: "Integrate BOSS into an app or addon", description: "A protocol-first integration checklist", argsSchema: { target: z.enum(["app", "addon"]) } }, ({ target }) => ({ messages: [{ role: "user", content: { type: "text", text: `Integrate BOSS in this ${target}. First read boss://docs/protocol, then ${target === "app" ? "boss://docs/app_guide and boss://docs/app_sdk" : "boss://docs/addon_guide and boss://docs/addon_example"}. Preserve discovery, canonical identity, pagination, extended search, source capability limits, series structure and guides. Keep listing separate from lazy playback. Use owned local test fixtures, not private credentials. Test HTTP ranges, cancellation and unsupported-capability handling. Do not invent unsupported outputs or claim lossless conversion.` } }] }));
  return server;
}

function createDeveloperMcp({ publicUrl, timeoutMs = 10000, maxConcurrent = 16, maxRequestsPerMinute = 600, clock = Date.now }) {
  const origin = new URL(publicUrl);
  for (const value of [timeoutMs, maxConcurrent, maxRequestsPerMinute]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid MCP request limits");
  let active = 0, windowStart = clock(), requests = 0;
  const error = (res, status, message) => {
    if (!res.headersSent && !res.destroyed) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } })); }
  };
  return async (req, res) => {
    if (req.headers.host !== origin.host || req.headers.origin && req.headers.origin !== origin.origin) return error(res, 403, "Untrusted MCP origin");
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": origin.origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Accept,MCP-Protocol-Version", "Vary": "Origin" }); return res.end(); }
    if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); return error(res, 405, "Use Streamable HTTP POST for the BOSS developer MCP"); }
    if (clock() - windowStart >= 60000) { windowStart = clock(); requests = 0; }
    if (active >= maxConcurrent || ++requests > maxRequestsPerMinute) { res.setHeader("Retry-After", "60"); return error(res, 429, "Developer MCP is busy; retry shortly"); }
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return error(res, 415, "Expected application/json");
    if (Number(req.headers["content-length"]) > 32768) return error(res, 413, "Request exceeds 32 KiB");
    active++;
    let server, transport;
    const timeout = setTimeout(() => res.destroy(), timeoutMs);
    let closing;
    const close = () => closing ||= (async () => { await transport?.close(); await server?.close(); })().catch(() => {});
    res.once("close", close);
    try {
      const parts = []; let size = 0;
      for await (const part of req) { size += part.length; if (size > 32768) { error(res, 413, "Request exceeds 32 KiB"); return; } parts.push(part); }
      let body;
      try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return error(res, 400, "Malformed MCP request"); }
      if (Array.isArray(body)) return error(res, 400, "Batched MCP messages are not supported");
      if (!body || typeof body !== "object") return error(res, 400, "Expected an MCP request object");
      if (res.destroyed || req.aborted) return;
      server = createDeveloperServer();
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.setHeader("Cache-Control", "no-store"); res.setHeader("Access-Control-Allow-Origin", origin.origin); res.setHeader("Vary", "Origin");
      await server.connect(transport);
      if (res.destroyed || req.aborted) return;
      await transport.handleRequest(req, res, body);
    } catch { error(res, 500, "Developer MCP request failed"); }
    finally { clearTimeout(timeout); res.off("close", close); await close(); active--; }
  };
}
module.exports = { createDeveloperMcp, createDeveloperServer, validateDescriptor };

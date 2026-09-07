"use strict";
const crypto = require("node:crypto");
const { itemId, canonicalId } = require("./jellyfin");
const { schedule } = require("../core/epg");
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function createJellyfinLive(library) {
  const graph = library.graph;
  const programId = row => Number(row.id).toString(16).padStart(16, "0") + crypto.createHmac("sha256", graph.secrets.key).update(JSON.stringify(["jellyfin-guide", library.collectionId, row.source_id, row.source_key, row.channel_id])).digest("hex").slice(0, 16);
  function record(row) {
    const channel = library.media(row.channel_id);
    return { Id: programId(row), Type: "Program", Name: row.title, Overview: row.description || "", ChannelId: itemId(channel), ChannelName: channel.title,
      StartDate: new Date(row.starts_at).toISOString(), EndDate: new Date(row.ends_at).toISOString(), RunTimeTicks: (row.ends_at - row.starts_at) * 10000, IsFolder: false };
  }
  function programs(params) {
    const allowed = ["userid", "api_key", "channelids", "startindex", "limit", "minstartdate", "maxstartdate", "minenddate", "maxenddate", "enabletotalrecordcount"];
    if (Object.keys(params).some(key => !allowed.includes(key))) throw fail("Unsupported guide filter", 422);
    const integer = (key, fallback) => { if (params[key] === undefined) return fallback; if (!/^\d+$/.test(params[key])) throw fail("Invalid guide pagination"); return Number(params[key]); };
    if (params.enabletotalrecordcount !== undefined && !["true", "false"].includes(params.enabletotalrecordcount)) throw fail("Invalid guide count option");
    let channelIds;
    if (params.channelids !== undefined) {
      const ids = params.channelids.split(",");
      if (!ids.length || ids.length > 100) throw fail("Invalid guide channels");
      channelIds = ids.map(id => { const media = library.media(canonicalId(id)); if (media.type !== "channel") throw fail("Guide requires channel IDs"); return media.id; });
    }
    const dates = {};
    for (const key of ["minStart", "maxStart", "minEnd", "maxEnd"]) if (params[`${key.toLowerCase()}date`] !== undefined) {
      const text = params[`${key.toLowerCase()}date`];
      if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) throw fail("Guide dates require an explicit timezone");
      dates[key] = Date.parse(text);
    }
    const result = schedule(graph, library.collection.sourceIds, { channelIds, ...dates, startIndex: integer("startindex", 0), limit: integer("limit", 100), count: params.enabletotalrecordcount !== "false" });
    return { Items: result.items.map(record), StartIndex: result.startIndex, ...(result.total !== undefined ? { TotalRecordCount: result.total } : {}) };
  }
  function program(id) {
    if (!/^[a-f0-9]{32}$/i.test(id)) throw fail("Invalid programme ID");
    const number = Number.parseInt(id.slice(0, 16), 16);
    if (!Number.isSafeInteger(number)) throw fail("Programme not found", 404);
    const row = graph.sql(`SELECT e.* FROM EPGEvents e WHERE e.id=? AND e.source_id IN (SELECT value FROM json_each(?))
      AND EXISTS(SELECT 1 FROM SourceMappings sm JOIN Sources s ON s.id=sm.source_id WHERE sm.media_id=e.channel_id AND sm.source_id=e.source_id AND sm.active=1 AND s.enabled=1)`).get(number, JSON.stringify(library.collection.sourceIds));
    if (!row || programId(row) !== id.toLowerCase()) throw fail("Programme not found", 404);
    return record(row);
  }
  return { programs, program };
}
module.exports = { createJellyfinLive };

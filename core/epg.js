"use strict";
const fail = message => Object.assign(new Error(message), { status: 400 });
function schedule(graph, sourceIds, { channelIds, startIndex = 0, limit = 100, minStart, maxStart, minEnd, maxEnd, count = true } = {}) {
  if (!Number.isSafeInteger(startIndex) || startIndex < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw fail("Invalid guide pagination");
  if (channelIds !== undefined && (!Array.isArray(channelIds) || channelIds.length > 100 || channelIds.some(id => !Number.isSafeInteger(id) || id < 1))) throw fail("Invalid guide channels");
  const now = graph.clock();
  for (const value of [minStart, maxStart, minEnd, maxEnd]) if (value !== undefined && (!Number.isSafeInteger(value) || Math.abs(value - now) > 30 * 86400000)) throw fail("Guide date must be within thirty days");
  minEnd ??= minStart ?? now;
  maxStart ??= maxEnd ?? minEnd + 7 * 86400000;
  if (maxStart < minEnd || maxStart - minEnd > 14 * 86400000 || minStart !== undefined && minStart > maxStart || maxEnd !== undefined && maxEnd < minEnd) throw fail("Invalid guide interval (maximum fourteen days)");
  const params = { sources: JSON.stringify(sourceIds), minEnd, maxStart };
  const clauses = ["e.source_id IN (SELECT value FROM json_each(@sources))", "e.ends_at>@minEnd", "e.starts_at<@maxStart",
    "EXISTS(SELECT 1 FROM SourceMappings sm JOIN Sources s ON s.id=sm.source_id WHERE sm.source_id=e.source_id AND sm.media_id=e.channel_id AND sm.active=1 AND s.enabled=1)"];
  for (const [key, sql] of [["minStart", "e.starts_at>=@minStart"], ["maxEnd", "e.ends_at<=@maxEnd"]]) if ({ minStart, maxEnd }[key] !== undefined) { params[key] = { minStart, maxEnd }[key]; clauses.push(sql); }
  if (channelIds !== undefined) { params.channels = JSON.stringify(channelIds); clauses.push("e.channel_id IN (SELECT value FROM json_each(@channels))"); }
  const where = clauses.join(" AND ");
  const total = count ? graph.sql(`SELECT count(*) n FROM EPGEvents e WHERE ${where}`).get(params).n : undefined;
  const items = graph.sql(`SELECT e.* FROM EPGEvents e WHERE ${where} ORDER BY e.starts_at,e.id LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset: startIndex });
  return { items, startIndex, total };
}
module.exports = { schedule };

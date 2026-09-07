"use strict";
function categoryNumber(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw Object.assign(new Error("Invalid category ID"), { status: 400 });
  return Number(value) - 1;
}
const active = `c.source_id IN (SELECT value FROM json_each(@sources))
  AND EXISTS(SELECT 1 FROM MediaCategories mc INDEXED BY MediaCategories_by_category
    WHERE mc.category_id=c.id AND EXISTS(SELECT 1 FROM SourceMappings sm
      WHERE sm.media_id=mc.media_id AND sm.source_id=c.source_id AND sm.active=1))`;
function record(row) {
  return { id: String(row.id + 1), name: ["other", "catalogue", "boss"].includes(row.protocol) ? `${row.source_name} | ${row.name}` : row.name, type: row.kind };
}
function primaryCategory(library, media, selected) {
  if (selected === "1") return { id: "1", name: "Boss Media", type: media.type };
  const row = library.graph.sql(`SELECT c.id,c.name,c.kind,s.name AS source_name,s.protocol
    FROM MediaCategories mc JOIN Categories c ON c.id=mc.category_id JOIN Sources s ON s.id=c.source_id
    WHERE mc.media_id=@media AND c.source_id IN (SELECT value FROM json_each(@sources))
    AND EXISTS(SELECT 1 FROM SourceMappings sm WHERE sm.media_id=@media AND sm.source_id=c.source_id AND sm.active=1)
    ${selected ? "AND c.id=@category" : ""} ORDER BY c.id LIMIT 1`).get({
    sources: JSON.stringify(library.collection.sourceIds), media: media.id,
    ...(selected ? { category: categoryNumber(selected) } : {})
  });
  return row ? record(row) : { id: "1", name: "Boss Media", type: media.type };
}
function categoryPage(library, params) {
  const type = params.get("type"), after = params.get("after") || "0", limit = Number(params.get("limit") || 100);
  if (!/^(0|[1-9]\d*)$/.test(after) || !Number.isSafeInteger(Number(after)) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new Error("Invalid category pagination"), { status: 400 });
  if (!["movie", "series", "channel", "event"].includes(type)) throw Object.assign(new Error("A category media type is required"), { status: 400 });
  if (!library.capabilities.types.includes(type)) return { categories: [], next: null };
  // Fetch one extra row for an exact, bounded continuation signal.
  const rows = library.graph.sql(`SELECT c.id,c.name,c.kind,s.name AS source_name,s.protocol
    FROM Categories c JOIN Sources s ON s.id=c.source_id
    WHERE ${active} AND c.kind=@type AND c.id>@after ORDER BY c.id LIMIT @limit`).all({
    sources: JSON.stringify(library.collection.sourceIds), type, after: Math.max(0, Number(after) - 1), limit: limit + 1
  });
  const categories = [...(after === "0" ? [{ id: "1", name: "Boss Media", type }] : []), ...rows.map(record)];
  const more = categories.length > limit;
  categories.length = Math.min(categories.length, limit);
  return { categories, next: more ? categories.at(-1).id : null };
}
module.exports = { categoryNumber, primaryCategory, categoryPage };

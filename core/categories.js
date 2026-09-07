"use strict";
const scope = key => JSON.stringify(key == null ? ["direct"] : ["catalogue", key]);
function prune(graph, sourceId) {
  graph.sql(`DELETE FROM MediaCategories WHERE category_id IN (SELECT id FROM Categories WHERE source_id=?)
    AND NOT EXISTS(SELECT 1 FROM CategoryProvenance p WHERE p.media_id=MediaCategories.media_id AND p.category_id=MediaCategories.category_id)`).run(sourceId);
}
function replace(graph, sourceId, input, mediaId, catalogKey, generation) {
  if (!Array.isArray(input.categories)) return;
  const key = scope(catalogKey);
  graph.sql(`DELETE FROM CategoryProvenance WHERE media_id=? AND category_id IN (SELECT id FROM Categories WHERE source_id=?)
    AND source_type=? AND source_key=? AND scope=?`).run(mediaId, sourceId, input.sourceType, input.sourceKey, key);
  for (const category of input.categories) {
    graph.sql("INSERT INTO Categories(source_id,source_key,name,kind) VALUES(?,?,?,?) ON CONFLICT(source_id,source_key,kind) DO UPDATE SET name=excluded.name").run(sourceId, String(category.key), category.name, category.kind || input.type);
    const row = graph.sql("SELECT id FROM Categories WHERE source_id=? AND source_key=? AND kind=?").get(sourceId, String(category.key), category.kind || input.type);
    graph.sql("INSERT OR REPLACE INTO CategoryProvenance VALUES(?,?,?,?,?,?)").run(mediaId, row.id, input.sourceType, input.sourceKey, key, generation);
    graph.sql("INSERT OR IGNORE INTO MediaCategories VALUES(?,?)").run(mediaId, row.id);
  }
  graph.sql(`DELETE FROM MediaCategories WHERE media_id=? AND category_id IN (SELECT id FROM Categories WHERE source_id=?)
    AND NOT EXISTS(SELECT 1 FROM CategoryProvenance p WHERE p.media_id=MediaCategories.media_id AND p.category_id=MediaCategories.category_id)`).run(mediaId, sourceId);
}
function retire(graph, sourceId, catalogKey, generation) {
  graph.sql(`DELETE FROM CategoryProvenance WHERE category_id IN (SELECT id FROM Categories WHERE source_id=?) AND scope=?
    AND (? IS NULL OR generation<>?)`).run(sourceId, scope(catalogKey), generation ?? null, generation ?? null);
  prune(graph, sourceId);
}
function retireLegacy(graph, sourceId, catalogKeys) {
  graph.sql(`DELETE FROM CategoryProvenance WHERE category_id IN (SELECT id FROM Categories WHERE source_id=@source) AND scope='["legacy"]'
    AND (@catalogs IS NULL OR media_id IN (SELECT cm.media_id FROM CatalogMembership cm JOIN IngestionJobs j ON j.source_id=cm.source_id AND j.catalog_key=cm.catalog_key
      WHERE cm.source_id=@source AND cm.generation=j.generation AND cm.catalog_key IN (SELECT value FROM json_each(@catalogs))))`).run({ source: sourceId, catalogs: catalogKeys == null ? null : JSON.stringify(catalogKeys) });
  prune(graph, sourceId);
}
module.exports = { replace, retire, retireLegacy };

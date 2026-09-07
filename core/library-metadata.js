"use strict";
const fields = ["title", "originalTitle", "year", "description", "runtimeSeconds", "rating", "certification", "releaseDate"];
function libraryMetadata(graph, media, sourceIds) {
  const result = { ...media, genres: [] };
  for (const field of fields) delete result[field];
  const genres = new Set();
  const rows = graph.sql(`SELECT md.document FROM Metadata md JOIN Sources s ON s.id=md.source_id
    WHERE md.media_id=? AND s.enabled=1 AND s.id IN (SELECT value FROM json_each(?))
    AND EXISTS(SELECT 1 FROM SourceMappings sm WHERE sm.media_id=md.media_id AND sm.source_id=md.source_id AND sm.active=1)
    ORDER BY s.priority DESC,s.id`).iterate(media.id, JSON.stringify(sourceIds));
  for (const row of rows) {
    const document = JSON.parse(row.document);
    for (const field of fields) if (result[field] === undefined && document[field] != null && document[field] !== "") result[field] = document[field];
    for (const value of Array.isArray(document.genres) ? document.genres : []) {
      const genre = String(value).trim(), key = genre.toLowerCase();
      if (genre && !genres.has(key) && result.genres.length < 100) { genres.add(key); result.genres.push(genre); }
    }
  }
  result.title ||= "Untitled";
  return result;
}
module.exports = { libraryMetadata };

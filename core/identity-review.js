"use strict";
function reviewPage(graph, after = 0) {
  if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error("Invalid review cursor"), { status: 400 });
  const rows = graph.sql("SELECT * FROM IdentityReviews WHERE id>? AND NOT EXISTS(SELECT 1 FROM CustomerSources o WHERE o.source_id=IdentityReviews.source_id) ORDER BY id LIMIT 100").all(after);
  return { reviews: rows.map(row => {
    const input = graph.sourceOpen(row.source_id, "quarantine", [row.catalog_key, row.source_type, row.source_key], row.encrypted_input);
    const identities = Object.fromEntries(Object.entries(input.externalIDs || {}).filter(([namespace, value]) => ["imdb", "tmdb", "tvdb"].includes(namespace) && value != null && value !== ""));
    const matches = new Map();
    const addMatch = (hit, namespace) => {
      if (!hit) return;
      const media = graph.media(hit.media_id);
      if (!media) return;
      const match = matches.get(media.id) || { canonicalId: media.canonicalId, title: media.title, type: media.type, year: media.year, identities: media.externalIDs, matchedBy: [] };
      match.matchedBy.push(namespace); matches.set(media.id, match);
    };
    addMatch(graph.sql("SELECT media_id FROM SourceMappings WHERE source_id=? AND source_type=? AND source_key=?").get(row.source_id, row.source_type, row.source_key), "source");
    for (const [namespace, value] of Object.entries(identities)) {
      addMatch(graph.sql("SELECT media_id FROM ExternalIDs WHERE namespace=? AND kind=? AND external_id=?").get(namespace, input.type, String(value)), namespace);
    }
    return { id: row.id, sourceId: row.source_id, sourceName: graph.source(row.source_id)?.name, type: input.type, title: input.title, identities, matches: [...matches.values()], updatedAt: row.updated_at };
  }), next: rows.length === 100 ? rows.at(-1).id : null };
}
module.exports = { reviewPage };

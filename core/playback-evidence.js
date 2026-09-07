"use strict";
const { createHmac } = require("node:crypto");
class PlaybackEvidence {
  constructor(graph, { maxEntries = 100000, retentionMs = 90 * 86400000 } = {}) {
    this.graph = graph; this.maxEntries = maxEntries; this.retentionMs = retentionMs;
  }
  fingerprint(mediaId, candidate) {
    const source = this.graph.source(candidate.sourceId);
    const headers = Object.entries(candidate.requiredHeaders || {}).sort(([a], [b]) => a.localeCompare(b));
    return createHmac("sha256", this.graph.secrets.key).update(JSON.stringify(["boss-http-evidence-v1", mediaId, candidate.sourceId, source?.revision, candidate.resource.url, headers])).digest("hex");
  }
  record(mediaId, candidate, { bytes = 0, outcome = "probe" } = {}) {
    const source = this.graph.source(candidate.sourceId);
    const canonical = this.graph.canonicalRow(mediaId);
    if (!source?.enabled || !canonical) return;
    mediaId = canonical.id;
    const now = this.graph.clock();
    bytes = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    const success = outcome === "complete" && bytes >= 1048576;
    const probe = outcome === "probe" || (outcome === "complete" && !success);
    this.graph.db.transaction(() => {
      this.graph.sql(`INSERT INTO PlaybackEvidence(fingerprint,source_id,source_revision,media_id,successful_transfers,probes,failures,interruptions,bytes_delivered,last_success,last_failure,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(fingerprint) DO UPDATE SET successful_transfers=successful_transfers+excluded.successful_transfers,
        probes=probes+excluded.probes,failures=failures+excluded.failures,interruptions=interruptions+excluded.interruptions,
        bytes_delivered=MIN(9007199254740991,bytes_delivered+excluded.bytes_delivered),
        last_success=COALESCE(excluded.last_success,last_success),last_failure=COALESCE(excluded.last_failure,last_failure),updated_at=excluded.updated_at`).run(
        this.fingerprint(mediaId, candidate), source.id, source.revision, mediaId, Number(success), Number(probe), Number(outcome === "failure"), Number(outcome === "interrupted"), bytes, success ? now : null, outcome === "failure" ? now : null, now);
      this.graph.sql("DELETE FROM PlaybackEvidence WHERE updated_at<?").run(now - this.retentionMs);
      this.graph.sql("DELETE FROM PlaybackEvidence WHERE fingerprint IN (SELECT fingerprint FROM PlaybackEvidence ORDER BY updated_at DESC LIMIT -1 OFFSET ?)").run(this.maxEntries);
    })();
  }
  bonus(mediaId, candidate) {
    const canonical = this.graph.canonicalRow(mediaId);
    const source = this.graph.source(candidate.sourceId);
    if (!canonical || !source?.enabled) return 0;
    const recent = this.graph.clock() - 86400000;
    const row = this.graph.sql("SELECT last_success,last_failure FROM PlaybackEvidence WHERE fingerprint=?").get(this.fingerprint(canonical.id, candidate));
    let success = row?.last_success ?? 0, failure = row?.last_failure ?? 0;
    if (!this.graph.sql("SELECT 1 FROM MediaItems WHERE merged_into=? LIMIT 1").get(canonical.id)) return success > recent && success > failure ? 5 : 0;
    // Retain the historical fingerprint's original ID; no private resource needs decrypting or rewriting.
    const history = this.graph.sql(`WITH RECURSIVE aliases(id) AS (
      VALUES(?) UNION SELECT m.id FROM MediaItems m JOIN aliases a ON m.merged_into=a.id
    ) SELECT e.media_id,e.fingerprint,e.last_success,e.last_failure FROM PlaybackEvidence e JOIN aliases a ON a.id=e.media_id
      WHERE e.source_id=? AND e.source_revision=? AND e.updated_at>?
      ORDER BY e.updated_at DESC LIMIT 1000`).all(canonical.id, source.id, source.revision, recent);
    for (const entry of history) if (entry.fingerprint === this.fingerprint(entry.media_id, candidate)) {
      success = Math.max(success, entry.last_success ?? 0);
      failure = Math.max(failure, entry.last_failure ?? 0);
    }
    return success > recent && success > failure ? 5 : 0;
  }
  summary() {
    return this.graph.sql("SELECT count(*) AS resources,COALESCE(sum(successful_transfers),0) AS successfulTransfers,COALESCE(sum(probes),0) AS probes,COALESCE(sum(failures),0) AS failures,COALESCE(sum(interruptions),0) AS interruptions FROM PlaybackEvidence").get();
  }
}
module.exports = { PlaybackEvidence };

"use strict";
class CatalogueRefresh {
  constructor(engine, { intervalMs = 24 * 3600000, retryMs = 60000 } = {}) {
    this.engine = engine; this.graph = engine.graph; this.intervalMs = intervalMs; this.retryMs = retryMs; this.pending = null; this.stopped = false;
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (!this.pending) this.pending = this.run().finally(() => { this.pending = null; });
    return this.pending;
  }
  async run() {
    const now = this.graph.clock();
    // Existing startup/manual jobs own their source; scheduled work never overlaps them.
    this.graph.sql("INSERT OR IGNORE INTO CatalogueRefresh(source_id,next_at) SELECT id,? FROM Sources WHERE enabled=1").run(now + this.intervalMs);
    const rows = this.graph.sql("SELECT r.* FROM CatalogueRefresh r JOIN Sources s ON s.id=r.source_id WHERE s.enabled=1 AND r.next_at<=? ORDER BY r.next_at,r.source_id LIMIT 100").all(now);
    const row = rows.find(item => !this.engine.sourceTasks.has(item.source_id));
    if (!row || this.stopped) return;
    const id = row.source_id;
    const unfinished = this.graph.sql("SELECT 1 FROM IngestionJobs j JOIN SourceCatalogs c ON c.source_id=j.source_id AND c.catalog_key=j.catalog_key WHERE j.source_id=? AND j.status<>'complete' AND j.error_code IS NOT 'CATALOGUE_PAUSED' LIMIT 1").get(id);
    this.graph.sql("UPDATE CatalogueRefresh SET status='running',last_started=?,next_at=? WHERE source_id=?").run(now, now + this.retryMs, id);
    try {
      await this.engine.ingestSource(id, { refresh: !unfinished, indexEpisodes: false });
      const finished = this.graph.clock();
      this.graph.sql("UPDATE CatalogueRefresh SET status='complete',last_finished=?,next_at=?,failures=0 WHERE source_id=?").run(finished, finished + this.intervalMs, id);
    } catch (error) {
      let delay = Math.min(this.intervalMs, this.retryMs * 2 ** Math.min(row.failures, 10));
      if ([error.upstreamStatus, error.status, error.response?.status].includes(429) && Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 && error.retryAfter <= (Number.MAX_SAFE_INTEGER - this.graph.clock()) / 1000) delay = Math.max(delay, error.retryAfter * 1000);
      this.graph.sql("UPDATE CatalogueRefresh SET status='failed',next_at=?,failures=failures+1 WHERE source_id=?").run(this.graph.clock() + delay, id);
    }
  }
  stop() { this.stopped = true; }
  status() {
    const counts = this.graph.sql(`SELECT m.type,count(*) AS count FROM MediaItems m WHERE m.merged_into IS NULL AND m.type IN ('movie','series')
      AND EXISTS(SELECT 1 FROM SourceMappings sm JOIN Sources s ON s.id=sm.source_id WHERE sm.media_id=m.id AND sm.active=1 AND s.enabled=1) GROUP BY m.type`).all();
    return { counts: Object.fromEntries(counts.map(row => [row.type, row.count])), intervalMs: this.intervalMs,
      sources: this.graph.sql("SELECT * FROM CatalogueRefresh ORDER BY next_at").all() };
  }
}
module.exports = { CatalogueRefresh };

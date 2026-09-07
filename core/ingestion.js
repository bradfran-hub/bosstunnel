"use strict";
const { setImmediate: nextTick } = require("node:timers/promises");

class CatalogueIngestor {
  constructor(graph, registry, { pageSize = 200 } = {}) { this.graph = graph; this.registry = registry; this.pageSize = Math.max(1, Math.min(pageSize, 1000)); this.running = new Map(); }
  ingest(sourceId, catalog, options = {}) {
    const key = `${sourceId}:${catalog.key}`;
    if (this.running.has(key)) return this.running.get(key);
    const task = this.run(sourceId, catalog, options).finally(() => this.running.delete(key));
    this.running.set(key, task); return task;
  }
  async run(sourceId, catalog, { signal, refresh = false, retainMissing = false } = {}) {
    const adapter = await this.registry.get(sourceId);
    if (!adapter.capabilities.catalog) throw new Error("Source does not provide a catalogue");
    let job = this.graph.sql("SELECT * FROM IngestionJobs WHERE source_id=? AND catalog_key=?").get(sourceId, catalog.key);
    if (job?.status === "complete" && !refresh) return { imported: job.imported_count, resumed: false };
    const generation = job ? job.generation + (refresh ? 1 : 0) : 1;
    let cursor = refresh ? null : job?.cursor || null;
    let imported = refresh ? 0 : job?.imported_count || 0;
    this.graph.sql("INSERT INTO IngestionJobs(source_id,catalog_key,cursor,generation,status,imported_count,updated_at) VALUES(?,?,?,?,'running',?,?) ON CONFLICT(source_id,catalog_key) DO UPDATE SET cursor=excluded.cursor,generation=excluded.generation,status='running',imported_count=excluded.imported_count,error_code=NULL,updated_at=excluded.updated_at").run(sourceId, catalog.key, cursor, generation, imported, this.graph.clock());
    let scan;
    try {
      scan = adapter.scanCatalog?.({ key: catalog.key, cursor, limit: this.pageSize, signal });
      do {
        signal?.throwIfAborted();
        if (!this.graph.source(sourceId)?.enabled) throw new Error("Source disabled during ingestion");
        const part = scan ? await scan.next() : null;
        if (part?.done) throw new Error("Streaming adapter ended without a final catalogue page");
        const page = scan ? part.value : await adapter.catalog({ key: catalog.key, cursor, limit: this.pageSize, signal });
        if (!Array.isArray(page.items) || page.items.length > this.pageSize) throw new Error("Adapter exceeded its catalogue page contract");
        if (page.nextCursor != null && String(page.nextCursor) === cursor) throw new Error("Source returned a non-advancing catalogue cursor");
        this.graph.db.transaction(() => {
          const options = { generation, catalogKey: catalog.key, allowTitleFallback: Boolean(adapter.allowTitleFallback) };
          let ids;
          const clearReview = input => this.graph.sql("DELETE FROM IdentityReviews WHERE source_id=? AND catalog_key=? AND source_type=? AND source_key=?").run(sourceId, catalog.key, input.sourceType || input.type, String(input.sourceKey));
          try {
            ids = this.graph.ingest(sourceId, page.items, options);
            for (const input of page.items) clearReview(input);
          } catch (error) {
            if (error.code !== "IDENTITY_CONFLICT") throw error;
            ids = [];
            // The failed batch rolled back. Savepoints isolate only conflicting identities.
            for (const input of page.items) {
              try { ids.push(...this.graph.ingest(sourceId, [input], options)); clearReview(input); }
              catch (itemError) {
                if (itemError.code !== "IDENTITY_CONFLICT") throw itemError;
                if (this.graph.sql("SELECT count(*) n FROM IdentityReviews WHERE source_id=?").get(sourceId).n >= 10000) throw new Error("Identity review queue is full");
                this.graph.sql(`INSERT INTO IdentityReviews(source_id,catalog_key,source_type,source_key,encrypted_input,updated_at) VALUES(?,?,?,?,?,?)
                  ON CONFLICT(source_id,catalog_key,source_type,source_key) DO UPDATE SET encrypted_input=excluded.encrypted_input,updated_at=excluded.updated_at`).run(sourceId, catalog.key, input.sourceType || input.type, String(input.sourceKey), this.graph.secrets.seal(input), this.graph.clock());
              }
            }
          }
          for (const mediaId of ids) this.graph.sql("INSERT INTO CatalogMembership VALUES(?,?,?,?) ON CONFLICT(source_id,catalog_key,media_id) DO UPDATE SET generation=excluded.generation").run(sourceId, catalog.key, mediaId, generation);
          imported += ids.length;
          cursor = page.nextCursor == null ? null : String(page.nextCursor);
          this.graph.sql("UPDATE IngestionJobs SET cursor=?,imported_count=?,updated_at=? WHERE source_id=? AND catalog_key=?").run(cursor, imported, this.graph.clock(), sourceId, catalog.key);
          if (cursor == null) {
            const review = this.graph.sql("SELECT 1 FROM IdentityReviews WHERE source_id=? AND catalog_key=? LIMIT 1").get(sourceId, catalog.key);
            if (!review && !retainMissing) {
            require("./categories").retire(this.graph, sourceId, catalog.key, generation);
            this.graph.sql("UPDATE SourceMappings SET active=0 WHERE source_id=? AND media_id IN (SELECT media_id FROM CatalogMembership WHERE source_id=? AND catalog_key=? AND generation<>?) AND NOT EXISTS(SELECT 1 FROM CatalogMembership cm WHERE cm.source_id=SourceMappings.source_id AND cm.media_id=SourceMappings.media_id AND (cm.catalog_key<>? OR cm.generation=?))").run(sourceId, sourceId, catalog.key, generation, catalog.key, generation);
            this.graph.sql("DELETE FROM CatalogMembership WHERE source_id=? AND catalog_key=? AND generation<>?").run(sourceId, catalog.key, generation);
            }
            this.graph.sql("UPDATE IngestionJobs SET status='complete',error_code=? WHERE source_id=? AND catalog_key=?").run(review ? "IDENTITY_REVIEW" : null, sourceId, catalog.key);
          }
        })();
        await nextTick();
      } while (cursor != null);
      return { imported, resumed: Boolean(job && !refresh) };
    } catch (error) {
      // Source errors may contain URLs or credentials; only stable codes are persisted.
      this.graph.sql("UPDATE IngestionJobs SET status='failed',error_code=?,updated_at=? WHERE source_id=? AND catalog_key=?").run(error.code === "IDENTITY_CONFLICT" ? error.code : "INGESTION_FAILED", this.graph.clock(), sourceId, catalog.key);
      throw error;
    } finally {
      if (scan?.return) await scan.return();
    }
  }
}
module.exports = { CatalogueIngestor };

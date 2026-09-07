"use strict";
const crypto = require("node:crypto");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const invalid = message => Object.assign(new Error(message), { status: 400 });
// Accounts support 32 sources; the resolver admits up to 200 choices per source.
const MAX_RESOURCES = 32 * 200;
class OutputState {
  constructor(graph, auth, protocol) { this.graph = graph; this.auth = auth; this.protocol = protocol; }
  read(session, media) {
    this.graph.collectionAccess(session.collectionId, { includeSignal: false }).assertCurrent();
    const row = this.graph.sql("SELECT * FROM OutputUserData WHERE collection_id=? AND protocol=? AND media_id=?").get(session.collectionId, this.protocol, media.id);
    return { Key: media.canonicalId, ItemId: media.canonicalId.replaceAll("-", ""), PlaybackPositionTicks: row?.position_ticks || 0, Played: Boolean(row?.played), IsFavorite: Boolean(row?.favorite), PlayCount: row?.play_count || 0,
      ...(row?.last_played ? { LastPlayedDate: new Date(row.last_played).toISOString() } : {}) };
  }
  update(session, media, patch) {
    const allowed = ["PlaybackPositionTicks", "Played", "IsFavorite"];
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw invalid("Unsupported user data field");
    for (const key of ["Played", "IsFavorite"]) if (patch[key] !== undefined && typeof patch[key] !== "boolean") throw invalid("Invalid user data flag");
    const position = patch.PlaybackPositionTicks;
    if (position !== undefined && (!Number.isSafeInteger(position) || position < 0 || position > 7 * 86400 * 10000000)) throw invalid("Invalid playback position");
    const current = this.read(session, media), now = this.graph.clock();
    this.graph.sql(`INSERT INTO OutputUserData(collection_id,protocol,media_id,position_ticks,played,favorite,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(collection_id,protocol,media_id) DO UPDATE SET position_ticks=excluded.position_ticks,played=excluded.played,favorite=excluded.favorite,updated_at=excluded.updated_at`).run(session.collectionId, this.protocol, media.id,
      position ?? current.PlaybackPositionTicks, Number(patch.Played ?? current.Played), Number(patch.IsFavorite ?? current.IsFavorite), now);
    return this.read(session, media);
  }
  create(token, media, resources = []) {
    const session = this.auth.verify(this.protocol, token), now = this.graph.clock();
    if (!Array.isArray(resources) || resources.length > MAX_RESOURCES) throw invalid("Invalid playback resource list");
    return this.graph.db.transaction(() => {
      this.graph.sql("DELETE FROM OutputPlays WHERE expires_at<=?").run(now);
      if (this.graph.sql("SELECT count(*) n FROM OutputPlays WHERE token_hash=?").get(hash(token)).n >= 64) throw Object.assign(new Error("Too many pending playback sessions"), { status: 429 });
      const id = crypto.randomUUID().replaceAll("-", ""), expiresAt = Math.min(session.expiresAt, now + 12 * 3600000);
      const collection = this.auth.collection(session.collectionId);
      const protectedCollection = this.protectedCollection(collection);
      const encrypted = protectedCollection ? `boss-output:1:${JSON.stringify(resources.map((resource, index) => {
        if (!resource || !collection.sourceIds.includes(resource.sourceId)) throw Object.assign(new Error("Playback resource is outside the library"), { status: 403 });
        return { sourceId: resource.sourceId, encrypted: this.graph.sourceSeal(resource.sourceId, "output-play", [this.protocol, hash(token), id, index], resource) };
      }))}` : this.graph.secrets.seal(resources);
      this.graph.sql("INSERT INTO OutputPlays(id,token_hash,media_id,resource_data,updated_at,expires_at) VALUES(?,?,?,?,?,?)").run(id, hash(token), media.id, encrypted, now, expiresAt);
      return { id, expiresAt };
    })();
  }
  verify(token, id, media) {
    const session = this.auth.verify(this.protocol, token);
    const play = this.graph.sql("SELECT * FROM OutputPlays WHERE id=? AND token_hash=?").get(id, hash(token));
    if (!play || play.media_id !== media.id || play.expires_at <= this.graph.clock()) throw Object.assign(new Error("Playback session expired or revoked"), { status: 401 });
    return { session, play };
  }
  protectedCollection(collection) {
    return Boolean(this.graph.sql("SELECT 1 FROM CustomerCollections WHERE collection_id=?").get(collection.id)) || collection.sourceIds.some(id => this.graph.sourceOwner(id));
  }
  resources(token, id, media) {
    const { session, play } = this.verify(token, id, media), collection = this.auth.collection(session.collectionId);
    if (!play.resource_data.startsWith("boss-output:1:")) {
      if (this.protectedCollection(collection)) throw Object.assign(new Error("Playback information requires a fresh password-protected session"), { status: 409 });
      return this.graph.secrets.open(play.resource_data);
    }
    let entries;
    try { entries = JSON.parse(play.resource_data.slice(14)); } catch { throw invalid("Invalid playback resource data"); }
    if (!Array.isArray(entries) || entries.length > MAX_RESOURCES) throw invalid("Invalid playback resource data");
    return entries.map((entry, index) => {
      if (!entry || !collection.sourceIds.includes(entry.sourceId)) throw Object.assign(new Error("Playback resource is outside the library"), { status: 403 });
      const resource = this.graph.sourceOpen(entry.sourceId, "output-play", [this.protocol, hash(token), id, index], entry.encrypted);
      if (resource?.sourceId !== entry.sourceId) throw invalid("Invalid playback resource owner");
      return resource;
    });
  }
  report(token, id, media, event, position) {
    return this.graph.db.transaction(() => {
      const { session, play } = this.verify(token, id, media), now = this.graph.clock();
      if (position !== undefined) this.update(session, media, { PlaybackPositionTicks: position });
      if (event === "start" && !play.started) {
        this.update(session, media, {});
        this.graph.sql("UPDATE OutputUserData SET play_count=play_count+1,last_played=?,updated_at=? WHERE collection_id=? AND protocol=? AND media_id=?").run(now, now, session.collectionId, this.protocol, media.id);
        this.graph.sql("UPDATE OutputPlays SET started=1,updated_at=? WHERE id=?").run(now, id);
      }
      if (event === "stop") this.graph.sql("DELETE FROM OutputPlays WHERE id=?").run(id);
      else this.graph.sql("UPDATE OutputPlays SET updated_at=? WHERE id=?").run(now, id);
      return this.read(session, media);
    })();
  }
}
module.exports = { OutputState };

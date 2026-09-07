CREATE TABLE IF NOT EXISTS Sources (
  id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL,
  name TEXT NOT NULL,
  configuration TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS SourceCapabilities (
  source_id TEXT PRIMARY KEY REFERENCES Sources(id) ON DELETE CASCADE,
  declaration TEXT NOT NULL,
  verified_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS MediaItems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('movie','series','season','episode','channel','event')),
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  original_title TEXT,
  year INTEGER,
  description TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  runtime_seconds INTEGER,
  rating REAL,
  certification TEXT,
  release_date TEXT,
  metadata_priority INTEGER NOT NULL DEFAULT 0,
  merged_into INTEGER REFERENCES MediaItems(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS MediaItems_browse ON MediaItems(type, merged_into, id);
CREATE INDEX IF NOT EXISTS MediaItems_alias ON MediaItems(merged_into) WHERE merged_into IS NOT NULL;
CREATE INDEX IF NOT EXISTS MediaItems_title_year ON MediaItems(type, normalized_title, year) WHERE merged_into IS NULL;
CREATE TABLE IF NOT EXISTS ExternalIDs (
  namespace TEXT NOT NULL CHECK(namespace IN ('imdb','tmdb','tvdb')),
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  media_id INTEGER NOT NULL REFERENCES MediaItems(id),
  PRIMARY KEY(namespace,kind,external_id),
  UNIQUE(media_id,namespace)
);
CREATE INDEX IF NOT EXISTS ExternalIDs_media ON ExternalIDs(media_id);
CREATE TABLE IF NOT EXISTS Movies (media_id INTEGER PRIMARY KEY REFERENCES MediaItems(id));
CREATE TABLE IF NOT EXISTS Series (media_id INTEGER PRIMARY KEY REFERENCES MediaItems(id));
CREATE TABLE IF NOT EXISTS Seasons (
  media_id INTEGER PRIMARY KEY REFERENCES MediaItems(id),
  series_id INTEGER NOT NULL REFERENCES Series(media_id),
  number INTEGER NOT NULL CHECK(number >= 0),
  UNIQUE(series_id,number)
);
CREATE TABLE IF NOT EXISTS Episodes (
  media_id INTEGER PRIMARY KEY REFERENCES MediaItems(id),
  series_id INTEGER NOT NULL REFERENCES Series(media_id),
  season_id INTEGER NOT NULL REFERENCES Seasons(media_id),
  season_number INTEGER NOT NULL CHECK(season_number >= 0),
  number INTEGER NOT NULL CHECK(number >= 0),
  UNIQUE(series_id,season_number,number)
);
CREATE INDEX IF NOT EXISTS Episodes_season ON Episodes(season_id,number);
CREATE TABLE IF NOT EXISTS Channels (
  media_id INTEGER PRIMARY KEY REFERENCES MediaItems(id),
  number TEXT,
  epg_id TEXT,
  catchup_days INTEGER NOT NULL DEFAULT 0,
  timeshift_seconds INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS LiveEvents (
  media_id INTEGER PRIMARY KEY REFERENCES MediaItems(id),
  channel_id INTEGER REFERENCES Channels(media_id),
  starts_at INTEGER,
  ends_at INTEGER
);
CREATE TABLE IF NOT EXISTS Categories (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  UNIQUE(source_id,source_key,kind)
);
CREATE TABLE IF NOT EXISTS MediaCategories (
  media_id INTEGER NOT NULL REFERENCES MediaItems(id),
  category_id INTEGER NOT NULL REFERENCES Categories(id) ON DELETE CASCADE,
  PRIMARY KEY(media_id,category_id)
);
CREATE INDEX IF NOT EXISTS MediaCategories_by_category ON MediaCategories(category_id,media_id);
CREATE TABLE IF NOT EXISTS CategoryProvenance (
  media_id INTEGER NOT NULL REFERENCES MediaItems(id),
  category_id INTEGER NOT NULL REFERENCES Categories(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY(media_id,category_id,source_type,source_key,scope)
);
CREATE INDEX IF NOT EXISTS CategoryProvenance_category ON CategoryProvenance(category_id,scope,generation);
CREATE TABLE IF NOT EXISTS EPGEvents (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES Channels(media_id),
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  UNIQUE(source_id,source_key,channel_id),
  CHECK(ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS EPGEvents_schedule ON EPGEvents(channel_id,starts_at,ends_at);
CREATE TABLE IF NOT EXISTS SourceMappings (
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  media_id INTEGER NOT NULL REFERENCES MediaItems(id),
  resolver_data TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  seen_generation INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(source_id,source_type,source_key)
);
CREATE INDEX IF NOT EXISTS SourceMappings_media ON SourceMappings(media_id,active,source_id);
CREATE INDEX IF NOT EXISTS SourceMappings_source ON SourceMappings(source_id,active,media_id);
CREATE TABLE IF NOT EXISTS SyntheticIDs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol TEXT NOT NULL,
  media_id INTEGER NOT NULL REFERENCES MediaItems(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS SyntheticIDs_media ON SyntheticIDs(protocol,media_id,id);
CREATE TABLE IF NOT EXISTS Metadata (
  media_id INTEGER NOT NULL REFERENCES MediaItems(id),
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  document TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(media_id,source_id)
);
CREATE TABLE IF NOT EXISTS Artwork (
  id INTEGER PRIMARY KEY,
  media_id INTEGER NOT NULL REFERENCES MediaItems(id),
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('poster','backdrop','logo','thumbnail')),
  resource TEXT NOT NULL,
  UNIQUE(media_id,source_id,kind)
);
CREATE TABLE IF NOT EXISTS ResolverMappings (
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  media_type TEXT NOT NULL,
  PRIMARY KEY(source_id,namespace,media_type)
);
CREATE TABLE IF NOT EXISTS ResolutionCache (
  cache_key TEXT PRIMARY KEY,
  media_id INTEGER NOT NULL REFERENCES MediaItems(id),
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL,
  encrypted_result TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ResolutionCache_expiry ON ResolutionCache(expires_at);
CREATE TABLE IF NOT EXISTS IngestionJobs (
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  catalog_key TEXT NOT NULL,
  cursor TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','complete','failed')),
  imported_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(source_id,catalog_key)
);
CREATE TABLE IF NOT EXISTS CatalogMembership (
  source_id TEXT NOT NULL,
  catalog_key TEXT NOT NULL,
  media_id INTEGER NOT NULL REFERENCES MediaItems(id),
  generation INTEGER NOT NULL,
  PRIMARY KEY(source_id,catalog_key,media_id),
  FOREIGN KEY(source_id,catalog_key) REFERENCES IngestionJobs(source_id,catalog_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS CatalogMembership_page ON CatalogMembership(source_id,catalog_key,media_id);
CREATE VIRTUAL TABLE IF NOT EXISTS MediaSearch USING fts5(title, original_title, content='MediaItems',content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS MediaSearch_insert AFTER INSERT ON MediaItems BEGIN
  INSERT INTO MediaSearch(rowid,title,original_title) VALUES(new.id,new.title,new.original_title);
END;
CREATE TRIGGER IF NOT EXISTS MediaSearch_delete AFTER DELETE ON MediaItems BEGIN
  INSERT INTO MediaSearch(MediaSearch,rowid,title,original_title) VALUES('delete',old.id,old.title,old.original_title);
END;
CREATE TRIGGER IF NOT EXISTS MediaSearch_update AFTER UPDATE OF title,original_title ON MediaItems BEGIN
  INSERT INTO MediaSearch(MediaSearch,rowid,title,original_title) VALUES('delete',old.id,old.title,old.original_title);
  INSERT INTO MediaSearch(rowid,title,original_title) VALUES(new.id,new.title,new.original_title);
END;
CREATE TABLE IF NOT EXISTS Collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS CollectionSources (
  collection_id TEXT NOT NULL REFERENCES Collections(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  PRIMARY KEY(collection_id,source_id)
);
CREATE TABLE IF NOT EXISTS SourceSync (
  source_id TEXT PRIMARY KEY REFERENCES Sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
  phase TEXT NOT NULL,
  error_code TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS SeriesHydration (
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES MediaItems(id),
  source_revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(source_id,media_id)
);
CREATE TABLE IF NOT EXISTS CollectionRevisions (
  collection_id TEXT PRIMARY KEY REFERENCES Collections(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO CollectionRevisions(collection_id) SELECT id FROM Collections;
CREATE TABLE IF NOT EXISTS CollectionProfiles (
  collection_id TEXT PRIMARY KEY REFERENCES Collections(id) ON DELETE CASCADE,
  profile TEXT NOT NULL DEFAULT '{}'
);
INSERT OR IGNORE INTO CollectionProfiles(collection_id) SELECT id FROM Collections;
CREATE TABLE IF NOT EXISTS SourceCatalogs (
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  catalog_key TEXT NOT NULL,
  PRIMARY KEY(source_id,catalog_key)
);
CREATE TABLE IF NOT EXISTS SourceGuideIDs (
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  epg_id TEXT NOT NULL,
  PRIMARY KEY(source_id,source_type,source_key),
  FOREIGN KEY(source_id,source_type,source_key) REFERENCES SourceMappings(source_id,source_type,source_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS SourceGuideIDs_lookup ON SourceGuideIDs(source_id,epg_id);
CREATE VIEW IF NOT EXISTS SourceSearchContent AS SELECT rowid, json_extract(document,'$.title') AS title, json_extract(document,'$.originalTitle') AS original_title FROM Metadata;
CREATE VIRTUAL TABLE IF NOT EXISTS SourceMediaSearch USING fts5(title,original_title,content='SourceSearchContent',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS SourceMediaSearch_insert AFTER INSERT ON Metadata BEGIN
  INSERT INTO SourceMediaSearch(rowid,title,original_title) VALUES(new.rowid,json_extract(new.document,'$.title'),json_extract(new.document,'$.originalTitle'));
END;
CREATE TRIGGER IF NOT EXISTS SourceMediaSearch_delete AFTER DELETE ON Metadata BEGIN
  INSERT INTO SourceMediaSearch(SourceMediaSearch,rowid,title,original_title) VALUES('delete',old.rowid,json_extract(old.document,'$.title'),json_extract(old.document,'$.originalTitle'));
END;
CREATE TRIGGER IF NOT EXISTS SourceMediaSearch_update AFTER UPDATE OF document ON Metadata BEGIN
  INSERT INTO SourceMediaSearch(SourceMediaSearch,rowid,title,original_title) VALUES('delete',old.rowid,json_extract(old.document,'$.title'),json_extract(old.document,'$.originalTitle'));
  INSERT INTO SourceMediaSearch(rowid,title,original_title) VALUES(new.rowid,json_extract(new.document,'$.title'),json_extract(new.document,'$.originalTitle'));
END;
PRAGMA user_version=10;
CREATE TABLE IF NOT EXISTS PlaybackEvidence (
  fingerprint TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL,
  media_id INTEGER NOT NULL REFERENCES MediaItems(id) ON DELETE CASCADE,
  successful_transfers INTEGER NOT NULL DEFAULT 0,
  probes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  interruptions INTEGER NOT NULL DEFAULT 0,
  bytes_delivered INTEGER NOT NULL DEFAULT 0,
  last_success INTEGER,
  last_failure INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS PlaybackEvidence_updated ON PlaybackEvidence(updated_at);
CREATE INDEX IF NOT EXISTS PlaybackEvidence_source_media ON PlaybackEvidence(source_id,source_revision,media_id,last_success);
CREATE TABLE IF NOT EXISTS CatalogueRefresh (
  source_id TEXT PRIMARY KEY REFERENCES Sources(id) ON DELETE CASCADE,
  next_at INTEGER NOT NULL,
  last_started INTEGER,
  last_finished INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS IdentityReviews (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES Sources(id) ON DELETE CASCADE,
  catalog_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  encrypted_input TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_id,catalog_key,source_type,source_key)
);

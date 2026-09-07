"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

// Unordered DAV directory entries are staged on disk, not retained as a library-sized array.
function createIndex() {
  const base = process.env.DATA_DIR || os.tmpdir();
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(base, "boss-dav-"));
  let db;
  try {
    db = new Database(path.join(directory, "listing.sqlite"));
    db.pragma("cache_size = -2048");
    db.exec("CREATE TABLE Entries(url TEXT PRIMARY KEY,parent TEXT NOT NULL,name TEXT COLLATE NOCASE NOT NULL,directory INTEGER NOT NULL,etag TEXT,modified TEXT); CREATE INDEX Entries_parent ON Entries(parent,name); CREATE INDEX Entries_page ON Entries(parent,url); CREATE TABLE Folders(id INTEGER PRIMARY KEY,url TEXT UNIQUE,depth INTEGER,context TEXT,done INTEGER DEFAULT 0); CREATE INDEX Folders_pending ON Folders(done,id)");
    const insert = db.prepare("INSERT OR IGNORE INTO Entries VALUES(@url,@parent,@name,@directory,@etag,@modified)");
    return { db, add: db.transaction(rows => { for (const row of rows) insert.run(row); }),
      close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { db?.close(); fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
module.exports = { createIndex };

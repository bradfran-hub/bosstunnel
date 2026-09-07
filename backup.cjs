"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { Secrets } = require("./core/secrets");

function verify(db, secret) {
  const version = db.pragma("user_version", { simple: true });
  if (version < 1 || version > 10) throw new Error("Unsupported Boss database version");
  for (const table of ["MediaItems", "Sources", "SourceMappings", "SyntheticIDs", "Collections"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error("Not a Boss database");
  }
  if (db.pragma("integrity_check", { simple: true }) !== "ok" || db.pragma("foreign_key_check").length) throw new Error("Database integrity check failed");
  const searchIndexes = [];
  for (const name of ["MediaSearch", ...(version >= 10 ? ["SourceMediaSearch"] : [])]) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!exists) {
      if (version >= 10) throw new Error("Required search index is missing");
      continue;
    }
    try { db.prepare(`INSERT INTO ${name}(${name},rank) VALUES('integrity-check',1)`).run(); }
    catch { throw new Error("Search index consistency check failed"); }
    searchIndexes.push(name);
  }
  if (secret !== undefined) {
    const secrets = new Secrets(secret);
    try { for (const row of db.prepare("SELECT configuration FROM Sources").iterate()) secrets.open(row.configuration); }
    catch { throw new Error("Encryption key cannot decrypt the source configurations"); }
  }
  return { schema: version, mediaItems: db.prepare("SELECT count(*) n FROM MediaItems").get().n, sources: db.prepare("SELECT count(*) n FROM Sources").get().n, searchIndexes };
}

async function snapshot(input, output, { secret } = {}) {
  input = path.resolve(input); output = path.resolve(output);
  if (input === output || fs.existsSync(output)) throw new Error("Destination must be a new file; overwriting is refused");
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(output), `.boss-backup-${crypto.randomUUID()}.sqlite`);
  let source, target, reserved = false;
  try {
    source = new Database(input, { readonly: true, fileMustExist: true, timeout: 5000 });
    source.pragma("query_only = ON");
    fs.closeSync(fs.openSync(temporary, "wx", 0o600)); reserved = true;
    await source.backup(temporary);
    target = new Database(temporary);
    target.pragma("journal_mode = DELETE");
    const report = verify(target, secret);
    target.close(); target = null;
    const fd = fs.openSync(temporary, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Hard-link publication is atomic and cannot replace a destination created concurrently.
    fs.linkSync(temporary, output);
    const directory = fs.openSync(path.dirname(output), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return { ...report, output };
  } finally {
    target?.close(); source?.close();
    if (reserved) for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(temporary + suffix, { force: true });
  }
}

async function main(args) {
  const [action, input, output, ...extra] = args;
  if (!["backup", "restore", "scheduled"].includes(action) || !input || !output || extra.length) throw new Error("Usage: node backup.cjs backup|restore|scheduled INPUT_DATABASE OUTPUT_FILE_OR_DIRECTORY");
  if (action === "restore" && !process.env.BOSS_SECRET) throw new Error("Restore requires the original BOSS_SECRET environment variable");
  const result = action === "scheduled" ? await scheduled(input, output, { secret: process.env.BOSS_SECRET }) : await snapshot(input, output, action === "restore" ? { secret: process.env.BOSS_SECRET } : {});
  console.log(JSON.stringify({ action, ...result }));
}
async function scheduled(input, directory, { secret, keep = 14 } = {}) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Error("Invalid backup retention count");
  if (!secret) throw new Error("Scheduled verification requires BOSS_SECRET");
  directory = path.resolve(directory);
  const name = `boss-scheduled-${Date.now()}-${crypto.randomUUID()}.sqlite`;
  const result = await snapshot(input, path.join(directory, name), { secret });
  // Only rotate our completed regular snapshots, and only after the new snapshot verifies.
  const previous = fs.readdirSync(directory).filter(file => file !== name && /^boss-scheduled-\d+-[a-f0-9-]{36}\.sqlite$/.test(file)).map(file => ({ file, stat: fs.lstatSync(path.join(directory, file)) })).filter(row => row.stat.isFile()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.file.localeCompare(a.file));
  let removed = 0;
  for (const row of previous.slice(keep - 1)) { fs.unlinkSync(path.join(directory, row.file)); removed++; }
  return { ...result, retained: Math.min(previous.length + 1, keep), removed };
}
if (require.main === module) {
  const keepAlive = setInterval(() => {}, 1000);
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
}
module.exports = { snapshot, scheduled };

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { Secrets } = require("./core/secrets");

function verify(db, secret) {
  const version = db.pragma("user_version", { simple: true });
  if (version < 1 || version > 16) throw new Error("Unsupported Boss database version");
  for (const table of ["MediaItems", "Sources", "SourceMappings", "SyntheticIDs", "Collections", ...(version >= 11 ? ["OutputAccounts", "OutputSessions"] : []), ...(version >= 12 ? ["OutputUserData", "OutputPlays"] : []), ...(version >= 13 ? ["Customers", "CustomerSessions", "CustomerSources", "CustomerCollections", "CustomerAuthAttempts"] : []), ...(version >= 14 ? ["CustomerVaults"] : []), ...(version >= 15 ? ["CustomerOutputLinks"] : [])]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error("Not a Boss database");
  }
  if (db.pragma("integrity_check", { simple: true }) !== "ok" || db.pragma("foreign_key_check").length) throw new Error("Database integrity check failed");
  if (version >= 15) {
    for (const row of db.prepare("SELECT l.*,o.customer_id AS owner,v.customer_id AS vault_owner FROM CustomerOutputLinks l JOIN CustomerCollections o ON o.collection_id=l.collection_id LEFT JOIN CustomerVaults v ON v.customer_id=l.customer_id").iterate()) {
      if (row.customer_id !== row.owner || !row.vault_owner || !row.encrypted_credentials.startsWith("boss-vault:1:")) throw new Error("Invalid output link ownership or encryption");
      let envelope;
      try { envelope = JSON.parse(row.encrypted_credentials.slice(13)); } catch { throw new Error("Invalid output link envelope"); }
      if (envelope?.version !== 1 || !["nonce", "tag", "data"].every(key => typeof envelope[key] === "string")) throw new Error("Invalid output link envelope");
    }
  }
  if (version >= 16) {
    for (const row of db.prepare("SELECT username,encrypted_profile FROM Customers").iterate()) {
      if (!/^[a-f0-9]{64}$/.test(row.username) || !row.encrypted_profile?.startsWith("boss-vault:1:")) throw new Error("Invalid password-protected customer profile");
    }
    for (const row of db.prepare("SELECT s.name,s.configuration FROM Sources s JOIN CustomerSources o ON o.source_id=s.id").iterate()) {
      if (!row.name.startsWith("boss-vault:1:") || !row.configuration.startsWith("boss-vault:1:")) throw new Error("Invalid password-protected customer source");
    }
    for (const row of db.prepare("SELECT c.name,p.profile FROM Collections c JOIN CustomerCollections o ON o.collection_id=c.id JOIN CollectionProfiles p ON p.collection_id=c.id").iterate()) {
      if (!row.name.startsWith("boss-vault:1:") || !row.profile.startsWith("boss-vault:1:")) throw new Error("Invalid password-protected customer library");
    }
  }
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
    try {
      const query = version >= 14 ? "SELECT s.configuration, o.customer_id, v.customer_id AS vault_owner FROM Sources s LEFT JOIN CustomerSources o ON o.source_id=s.id LEFT JOIN CustomerVaults v ON v.customer_id=o.customer_id" : "SELECT configuration FROM Sources";
      for (const row of db.prepare(query).iterate()) {
        if (row.configuration.startsWith("boss-vault:1:")) {
          if (!row.customer_id || !row.vault_owner) throw new Error("Missing vault ownership");
          const envelope = JSON.parse(row.configuration.slice(13));
          if (envelope.version !== 1 || !["nonce", "tag", "data"].every(key => typeof envelope[key] === "string")) throw new Error("Invalid vault envelope");
          // Structural verification is possible while locked; decryption requires
          // the customer's password and must never use the backup server key.
        } else secrets.open(row.configuration);
      }
    }
    catch { throw new Error("Encryption key cannot decrypt the source configurations"); }
  }
  return { schema: version, mediaItems: db.prepare("SELECT count(*) n FROM MediaItems").get().n, sources: db.prepare("SELECT count(*) n FROM Sources").get().n, searchIndexes };
}

async function snapshot(input, output, { secret, revokeSessions = false } = {}) {
  if (revokeSessions && !secret) throw new Error("Restore requires the original BOSS_SECRET environment variable");
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
    target.pragma("foreign_keys = ON");
    target.pragma("journal_mode = DELETE");
    const report = verify(target, secret);
    if (revokeSessions) {
      report.revokedSessions = target.transaction(() => {
        let count = 0;
        if (report.schema >= 11) count += target.prepare("DELETE FROM OutputSessions").run().changes;
        if (report.schema >= 13) {
          count += target.prepare("DELETE FROM CustomerSessions").run().changes;
          target.prepare("UPDATE Customers SET revision=revision+1").run();
        }
        target.prepare("DELETE FROM ResolutionCache").run();
        return count;
      })();
      verify(target, secret);
    }
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
  const result = action === "scheduled" ? await scheduled(input, output, { secret: process.env.BOSS_SECRET }) : action === "restore" ? await restore(input, output, { secret: process.env.BOSS_SECRET }) : await snapshot(input, output);
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
function restore(input, output, { secret } = {}) { return snapshot(input, output, { secret, revokeSessions: true }); }
module.exports = { snapshot, scheduled, restore };

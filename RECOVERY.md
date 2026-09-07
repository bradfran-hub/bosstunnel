# Boss Database Recovery

The database contains canonical identities, synthetic player IDs, libraries and encrypted source credentials. Preserve the original `BOSS_SECRET` separately in secure backup storage; existing Xtream passwords are derived from that secret. Preserve `BOSS_ADMIN_TOKEN` to retain the same management login. A database backup alone cannot recover a lost encryption key.

## Online Backup

Run from the project directory on the VPS:

```sh
docker compose exec bossmedia node backup.cjs backup /app/data/boss.db /app/data/backups/boss-YYYYMMDD-HHMM.sqlite
```

Use a new filename each time. The command uses SQLite's online backup API, so the running database can remain in WAL mode. It validates the completed snapshot, publishes it atomically without overwriting an existing file, and creates the snapshot with owner-only permissions. It does not decrypt credentials or print configuration values.

Copy completed snapshots to separate, access-controlled storage outside this VPS. Backups inside the data volume survive image rebuilds but not loss of the VPS or volume. Off-server transfer is not configured. Keep encryption keys separate from the snapshots and restrict both.

Verification also compares full-text indexes against their underlying records. Schema 16 snapshots require both the canonical and source-specific search indexes and validate customer vault ciphertext structure without decrypting it. A snapshot can pass SQLite's structural integrity check but fail this consistency check; such a snapshot is not published and does not trigger retention rotation.

## Scheduled Snapshots

The VPS units in `ops/boss-media-backup.service` and `ops/boss-media-backup.timer` run daily at 03:15 UTC with up to ten minutes of jitter. Missed runs are caught up when the timer starts. They execute `node /app/backup.cjs scheduled /app/data/boss.db /app/data/backups/scheduled` in the running Boss container. Only fourteen successfully published scheduled snapshots are retained. Rotation ignores manual files and runs only after integrity, foreign-key and source-credential decryption checks succeed. A snapshot failure fails the service; inspect `systemctl status boss-media-backup.service` and `journalctl -u boss-media-backup.service`. This is local recovery protection, not off-site disaster recovery.

Install or update the units with `sudo install -m 644 ops/boss-media-backup.service ops/boss-media-backup.timer /etc/systemd/system/`, then `sudo systemctl daemon-reload` and `sudo systemctl enable --now boss-media-backup.timer`. Deploy the matching backup command before starting the timer. No Saint TV units are modified.

## Restore Drill

```sh
docker compose exec bossmedia node backup.cjs restore /app/data/backups/boss-YYYYMMDD-HHMM.sqlite /app/data/recovery-check/boss.db
```

The container supplies its existing `BOSS_SECRET`. Restore requires that key, verifies that source configurations decrypt, checks SQLite integrity and foreign keys, and refuses any existing destination. An empty database has no encrypted source records against which to verify a key. Restore does not merge databases or start a service against the recovered file.

This drill leaves the running `/app/data/boss.db` untouched. Use a new recovery directory for each drill. Treat the recovered database as sensitive, even though credentials remain encrypted.

## Cutover

Management authentication has an in-process failed-token throttle: 30 failures per socket peer in a 60-second window. Further management attempts receive `429` with `Retry-After` until that window expires, including attempts with the correct token. Forwarding headers do not change the peer identity. Behind the deployed reverse proxy, clients can share this bucket; wait for the indicated cooldown rather than repeatedly submitting tokens. Health and player routes are not part of this management throttle. This is not a substitute for per-client edge rate limits, a strong admin credential, or network access controls.

1. Retain a fresh snapshot of the current database when it is readable.
2. Stop Boss with `docker compose stop bossmedia` before changing its data path. Do not alter Saint TV services or domains.
3. Restore into a new directory using a one-off container, for example `docker compose run --rm --no-deps bossmedia node backup.cjs restore /app/data/backups/boss-YYYYMMDD-HHMM.sqlite /app/data/recovered/boss.db`.
4. Set the Boss service's `DATA_DIR` to `/app/data/recovered` in `compose.yaml`, keeping the original secret, admin token, base URL and volume mount. Never replace or delete a running SQLite database or its WAL files.
5. Recreate the Boss service with `docker compose up -d bossmedia`. Verify public health, library membership, old player IDs and authorized playback before accepting traffic as recovered.

Keep the previous data directory until verification is complete. To roll back, stop Boss, restore its previous `DATA_DIR` value, and recreate it. New changes made after either snapshot belong only to that database; this procedure does not reconcile divergent histories. A backup of an older schema is migrated by the application on startup. A database from a newer unsupported schema is rejected.

The schema-16 restore command clears stored customer/output login sessions
and temporary resolution cache in the **new restored copy**, before publication.
Session-linked output plays are deleted by foreign-key cascade. The source backup
and running database are unchanged; users must sign in again. Ordinary backup
snapshots retain their state and do not log out live users.

Restore is still a rollback of account passwords, recovery digests, source
credentials and library memberships to the backup time. It does not invalidate
older native addon URLs or Xtream credentials, or remember post-backup deletions.
Do not expose a restored instance until those changes have been reconciled and
compromised playback credentials revoked. Session clearing alone is not complete
credential recovery. This behavior is included in the deployed schema-16 image.

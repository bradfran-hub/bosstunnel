# Password-Only Customer Vault

Status: deployed for customer accounts on schema 16. Customer source credentials,
configuration, labels, library names/profiles, private caches and output secrets
use the password vault. Existing administrator-owned source records continue to
use `BOSS_SECRET`; they are not customer data and are never assigned by signup.
Canonical media identity/metadata remains shared and authorization-scoped.

## Installation Credential Storage

`core/output-links.js` adds random 256-bit customer installation tokens and
independent Xtream passwords. Schema 16 stores indexed SHA-256 lookup hashes,
the owning account revision, and password-vault-encrypted recoverable credentials.
The vault envelope binds the customer, output-link purpose and internal library
ID. Public tokens are not internal library IDs or derivatives of BOSS_SECRET.

Storage operations require an enabled owner and unlocked collection access.
Rotation invalidates both credentials; account revision changes invalidate old
links and require explicit rotation. Logout/expiry blocks link authentication
until password unlock. Deleting the collection cascades its stored links.
Restart preserves credentials but never unlocks them. Backup verification checks
ownership/envelope structure, not password decryption. Existing upstream URLs
already handed to players cannot be revoked by changing BOSS links.

HTTP routes and management UI use this module. Customer native paths
resolve hashed tokens, and Xtream validates the independent password hash.
Internal customer IDs and server-derived customer passwords no longer authorize
HTTP output. Existing administrator-only links remain compatible. Public
registration is enabled on the deployed schema-16 release.

The integration separates internal and public lookups:

- Management authenticates the owner and returns decrypted installation URLs.
- Native incoming paths resolve a hashed public token to an internal collection;
  an internal customer collection ID must never remain a legacy public fallback.
- Xtream authenticates the supplied random pair by hash, then opens the internal
  collection. It must not call the server-key credential helper for customers.
- Generated artwork, guide, playlist, playback and resource URLs carry the public
  token; encrypted resource tickets still bind the internal collection identity.
- `POST /api/libraries/{id}/installation/rotate` requires an authenticated,
  CSRF-protected owner operation. The workspace exposes this for both default
  source and merged libraries. Old public prefixes fail authentication before
  interpreting a child route or resource ticket. OutputLibrary rechecks the
  captured token at authorization boundaries so rotation cannot revive old work.
- Administrator-only legacy URLs stay compatible. Unowned collections containing
  customer sources are rejected by the HTTP output path. Management forbids
  creating such collections and requires the customer owner to edit sources,
  provision outputs or rotate credentials. Administrator listings retain
  administrative metadata, but do not return customer installation credentials.
- Account revision changes show an explicit revoked-link state in the workspace;
  the owner can generate fresh credentials after password login without losing
  catalogue or synthetic identities.

HTTP fixtures cover all eight principal catalogue/export routes before and
after lock and rotation, CSRF, cross-account isolation, administrator disclosure
and legacy customer URL rejection. Browser fixtures exercise rotation and the
password-change recovery state across responsive layouts. Playback/search parity
with the direct-only baseline, process restart, schema migration and customer-field
privacy are covered by the release suite and production-copy migration drill.

## Implemented Primitive

`core/password-vault.js` uses Node crypto's scrypt and AES-256-GCM. A fresh random
32-byte data key is wrapped by a password-derived 32-byte key using an independent
16-byte salt, scrypt N=131072/r=8/p=1, a random 12-byte nonce and 16-byte GCM tag.
The stored authentication hash is never used as a decryption key. The module has
no administrator-key, environment-secret or recovery-code decryption path.
These choices follow [OWASP storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
and [password KDF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
using the [Node 22 crypto API](https://nodejs.org/docs/latest-v22.x/api/crypto.html).

Authenticated associated data binds each ciphertext to its customer, purpose
and record identity. Wrappers additionally bind the KDF version and salt.
Unknown envelope versions or KDF parameters, noncanonical encodings, malformed
tags, and records larger than 8 MiB fail closed. No automatic fallback attempts
server-key decryption when a customer record fails.

The unlock store has a bounded one-worker/eight-waiter KDF queue and at most
1024 active customer keys by default. Unlock duration is fixed, default one hour,
configurable from one second to 24 hours. Reading media does not extend it.
This is an implementation default, not a released customer UX contract.
Access after expiry fails even before the cleanup timer runs. Explicit lock,
expiry, replacement and shutdown abort the unlock's signal. Asynchronous callers
must pass that signal into source requests and recheck `assertCurrent()` before
publishing results or performing writes. Locked or replaced work must not resume
merely because the customer unlocks a new session.

The module overwrites owned key/plaintext buffers where possible. JavaScript
strings, parsed objects, application caches, runtime/native-library copies,
swap and crash dumps cannot be guaranteed erased by Buffer.fill. No claim of
active-compromise immunity or complete process-memory erasure is made.

## API And Persistence Rules

- `create(customerId, password)` creates an unlocked data key and returns only
  its wrapped envelope. The caller must persist that wrapper atomically with a
  unique account creation and lock the vault if the transaction fails. Never use
  create to replace an existing persisted vault, even when currently locked.
- `unlock(customerId, password, wrapper)` verifies the wrapped key and installs
  a fresh bounded unlock. The caller must validate account enablement and wrapper
  revision before and after asynchronous derivation; stale revisions must lock.
- `seal/open(customerId, purpose, recordId, value)` encrypt/decrypt a bounded
  structured record. Pass immutable owner/purpose/ID from authoritative storage,
  not untrusted envelope fields.
- `access(customerId)` returns an abort signal and assertCurrent guard for the
  present unlock, never a key. Lock must also invalidate adapter and response
  caches: cancelling a signal does not itself drop credential-bearing objects.
- `rewrap(customerId, oldPassword, newPassword, wrapper)` returns a new wrapped
  copy of the same data key, preserving encrypted records. It does not install
  the key or mutate persistence. Atomically update authentication hash, wrapper
  revision and web/output revocations, lock old access, then explicitly unlock.
- `lock(customerId)` cancels pending unlocks and aborts active access. `close()`
  rejects pending work, waits for active derivations and clears owned keys.
- Only wrapped envelopes and ciphertext belong on disk. No data key is returned
  for storing in sessions, tickets, environment variables or a master-key copy.

Losing the password loses the ability to decrypt the existing vault. A recovery
code authorizes an explicitly confirmed destructive reset: all old sources and
libraries are deleted, sessions and links are revoked, and a fresh empty vault,
password and recovery code are created. Recovery never decrypts the old vault.

Changing a password does not invalidate ciphertext in backups that retain the
old wrapped key: possession of that backup and old password can still decrypt
that historical data. Backup rotation/deletion and incident recovery need their
own policies. Direct playback URLs already given to a trusted player are governed
by the upstream; locking BOSS cannot revoke them or stop an existing stream.

## Account Integration

Schema 16 includes `CustomerVaults` without creating wrappers for legacy accounts.
New registration commits the account, wrapper and session in one transaction;
failure clears the newly unlocked key. Login verifies the authentication hash
and separately unwraps the data key. Account enablement, authentication revision,
wrapper revision and wrapper contents are checked across asynchronous derivation.
Legacy login and password changes require explicit migration, never an automatic
server-key fallback.

`CustomerAuth.vaultAccess(id)` binds a guarded context to current persisted
account/wrapper state. Callers must use this guard as well as the primitive's
signal before releasing data. Direct SQL account changes do not themselves
interrupt in-flight I/O: owner-scoped storage, registry eviction and request
cancellation remain release gates. Source configuration/mapping/artwork reads,
resolver cache reads/writes and registry adapter work now consume this guard.
Not every background job or metadata/output response path is integrated yet.

Password changes atomically rewrap the same data key, increment both revisions,
revoke web and output sessions, abort old access and leave the vault locked.
Existing installation URLs and upstream credentials are not rotated. The user
must sign in again with the new password. Recovery codes cannot decrypt or reset
existing data. Backup restore preserves the wrapper, revokes sessions, and does
not unlock anything using the server secret. Backup verification currently
checks structural database integrity, not password-only ciphertext decryption.

`/account/me` reports vault status without unlocking. CSRF-protected
`POST /account/lock` locks without deleting the web session. Logout locks shared
customer access, including when other cookies are still valid; login with the
password is required again. Management HTTP requests reject a locked vault with
423. The local workspace hides retained source/library views and prompts for the
password after lock, restart or password change. A replacement cookie for the
same newly authenticated customer must not relock the vault.

## Source Storage (Local)

New customer source configurations, resolver mappings, artwork resources,
quarantined inputs and persistent stream-resolution results use versioned
`boss-vault:1:` ciphertext. Ownership comes from `CustomerSources`, not the
ciphertext. AAD binds the source, purpose and stable record identity. Mapping
keys and artwork primary keys survive canonical merges; artwork IDs also survive
VACUUM. Existing server-key customer records are refused with an explicit
migration error, never automatically decrypted or copied into a new vault.
Noncredential source edits retain ciphertext unchanged while locked.

Registered source adapters are bound to the unlock that created them. Lock evicts
cached adapters, aborts guarded factory/method results and deferred catalogue
iteration, and prevents stale initialization from replacing a newer adapter.
Scoped fetch requests combine the unlock signal with caller cancellation; the
media-server SDK uses the same combined signal. Iterator cleanup remains allowed
but cannot start new network requests with locked access. Queued resolver work
is cancelled before it starts, and results are checked again before cache writes
and final publication.

Customer addon/WebDAV response caches and expanded-search cursor caches use
encrypted values and hashed keys. A stale unlock cannot read or repopulate them
after locking, even after a later password login. Customer artwork bypasses the
shared plaintext artwork cache and reads its encrypted, indexed database rows.
Administrator identity reviews omit customer quarantine records. The underlying
canonical metadata, source/library names, search job state, other metadata caches
and output credentials still require a separate privacy/storage audit.

Backup verification recognizes encrypted customer source records and validates
their ownership/envelope structure without trying the server secret. That is not
a cryptographic decryption check; password-authenticated restore testing remains
required. The production image does not contain the experimental account/network
dependency set; release builds must install the candidate lockfile, including
`undici` and `ipaddr.js`, rather than copying code over the current live image.

## Required Integration Before Signup

1. Finish explicit migration of existing accounts using the real password.
   Versioned persistence and account/revision binding are implemented for new
   accounts; never synthesize a server-readable recovery wrapper for old ones.
2. Complete password-only storage for personal metadata, source/library names,
   account profile data and output/session secrets. New source configuration,
   mappings, artwork, quarantine and resolver caches are integrated locally.
   Audit SQLite indexes, WAL, backups and caches for retained legacy copies.
3. Stop and invalidate queued ingestion, registry adapters, source responses,
   resolver results and metadata operations on lock. Carry unlock signals into
   requests/iterators and assert the same unlock before returning any secret.
4. Make startup skip locked customer ingestion and return a clear locked-vault
   response for new output resolution. Never bootstrap keys from a web cookie,
   output token or environment secret after restart. Direct playback remains
   adapter-only; the older experimental proxy must not be reintroduced.
5. Extend the implemented auth lock/login/password/restore lifecycle to all
   source/cache/output operations; implement destructive reset, deletion and
   output-token rotation. Finish the real customer Get Started/signup/login UX
   and cookie/CSRF/edge validation.
6. Test DB-copy attacks with BOSS_SECRET and password verifiers, migration on a
   verified production copy, asynchronous revocation races, profile/metadata
   privacy, restart and restore. Obtain security review of the complete system,
   not just this primitive, before claiming password-only customer storage.

## Scheduled Refresh (Local)

The daily scheduler selects only administrator sources or sources owned by a
currently unlocked customer. Owner eligibility is checked before the database's
100-row result limit, so locked sources cannot fill that page and starve other
customers. Only the bounded in-memory unlock-owner list is passed into the query;
the scheduler does not load every source into an application array.

A lock during an active scheduled refresh returns that schedule to pending,
preserving its due time and provider failure count. After password unlock, the
next eligible tick can resume it. An actual upstream HTTP 423 still counts as a
provider failure when the vault remains unlocked.

Startup discovery now iterates only enabled administrator source IDs directly
from SQLite. Customer sources are not automatically queued at process startup,
when no password-derived keys exist. Both the ingestion entry point and its
runner reject locked customer access before recording discovery/job status.
After password login, an explicit ingestion request or an eligible scheduled
refresh can run normally. Automatic restart-resume UX and complete ingestion
checkpoint privacy still require work.

## Output Access (Local)

`collectionAccess` requires current password access for the collection owner and
every customer-owned source in it. An administrator/unowned collection containing
a customer source cannot bypass that source's lock. Noncustomer libraries keep
their previous access behavior. Output account provisioning, password rotation,
login and session verification reject locked access with 423.

Each `OutputLibrary` captures the current unlock generation. An old request
context stays invalid after a later login, rather than reviving in-flight work.
Native descriptors, compatibility outputs, Xtream responses, M3U and XMLTV use
the shared guard. Catalogue iteration and programme pages recheck between items;
catalogue/guide exports also stop if the collection revision changes mid-export.
The HTTP fixture verifies eight native/compatibility/Xtream/playlist/guide routes
return 423 while locked and work after password login.

An otherwise-valid output session can be used again after the customer explicitly
unlocks with the password. Lock is not permanent output credential revocation.
Previously handed-off direct provider URLs, downloaded catalogues and already
running provider-to-player streams cannot be recalled by BOSS. Players should
treat 423 as a locked-account condition, not an empty source list or an invitation
to retry continuously. Installation-link credentials are password encrypted and
rotation is available in the workspace.

Stored playback choices for customer-containing libraries now use a versioned
`boss-output:1:` record with each candidate encrypted under its source's key.
The authentication context binds output protocol, session-token hash, play ID
and candidate position. A database attacker cannot move ciphertext between play
records or sessions to recover it. Candidate source membership is checked before
storing and reading, and customer records cannot fall back to legacy server-key
decryption. Native provider URLs, headers and quality fields remain unchanged
after decrypting. Administrator-only legacy playback records keep their existing
server-key storage. Structural record membership/source IDs and timestamps are
not secret profile fields. Experimental Jellyfin user state is a separate disabled
output surface and is not exposed by customer signup.

## Verification

`node --test test/password-vault.cjs` exercises ciphertext persistence across
discarded process state, independent server-key rejection, wrong passwords,
owner/purpose/record swaps, nonce/tag/data tampering, random salts/nonces,
rewrapping, fixed expiry, bounded capacity/queue, lock and shutdown races,
unlock-generation cancellation and malformed/oversized inputs. These are local
module tests, not proof that all customer storage is secured.

`node --test test/customer-vault.cjs test/customer-auth.cjs` adds account wrapper
persistence, cookie/server-key/password-verifier/recovery-code rejection,
transaction rollback, revocation races, password rewrap, legacy schema migration,
backup restore and management lock checks. `node test/customer-browser.cjs`
checks locked and unlocked flows at 1440, 390 and 320px.

`node --test test/source-vault.cjs` verifies real source storage/restart, server-key
rejection, record swaps, canonical merge/VACUUM stability, encrypted resolution
and response caches, late initialization/results, fetch abort, queued resolver
cancellation and deferred-iterator cleanup. These do not prove all profile,
metadata, output and legacy data paths are password-protected.

`node --test test/output-vault.cjs` covers output credential/session lock checks,
stale library contexts, cached-page iteration, XMLTV mid-page cancellation,
library-revision changes, mixed administrator/customer source collections, and
merged-source playback record encryption with cross-play/token swap rejection.

`node --test test/refresh-vault.cjs` checks locked-source scheduling fairness,
password-unlock resume, mid-refresh lock pausing, and upstream-423 distinction.

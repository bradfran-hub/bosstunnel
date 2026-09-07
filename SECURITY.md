# Security Boundaries

This release is an administrator-managed media gateway. It is not a zero-knowledge
vault and does not offer public customer registration.

Source configurations and temporary resolver resources use AES-256-GCM with
random nonces. The deployment's BOSS_SECRET controls decryption. Keep it separate
from database backups. Anyone with both the key and database can decrypt those
records; compromise of the running server may expose currently used credentials.
Titles, catalogue metadata and membership records are not a fully encrypted vault.

Private addon URLs, Xtream credentials and protected playback links grant access.
Never publish them, include them in analytics, or share them in public issues.
Use HTTPS, strong independent secrets, restricted administration and prompt updates.
Native source author credentials are origin-scoped. Source administrators may
intentionally connect private-network servers; source management is trusted-only.

## Password-Only Vault Requirement (Not Yet Implemented)

Public customer onboarding must remain disabled until this separate change is
implemented and reviewed. Requirements include independently salted, memory-hard
password derivation; a random per-user data key encrypted under the password key;
authenticated, user-bound encryption of sensitive records; and no server-master-key
fallback for customer vaults.

Source authentication, resolver caches, playback tickets, metadata that contains
private paths, backups, logs and source-isolation boundaries all require review.
No duplicate decryptable credentials may remain in legacy storage. Migration
must be explicit and verified before old encrypted copies and backups are retired.

Unlock keys must not be persisted on the server. A restart, lock or expiry must
require re-unlocking before playback or ingestion that needs source credentials.
Password changes require an unlocked vault and rewrapping its key. Password reset
without the original key cannot recover a password-only vault. Authentication
recovery must not silently become a separate vault decryption backdoor.

Even this design cannot guarantee protection from an active attacker controlling
the server or client while a vault is unlocked. Stronger server-blind protection
requires client-side cryptography and changes to where source resolution runs.

Do not describe the current release as password-only encrypted, zero-knowledge,
or immune to compromise.

## Reporting

Use GitHub private vulnerability reporting when available. Do not open a public
issue containing credentials, private access links, customer data or exploit details.

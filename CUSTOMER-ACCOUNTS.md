# Customer Accounts

Deployed at `https://bosstunnel.com/workspace` on schema 16 with
`BOSS_CUSTOMER_ACCOUNTS=true`. There is no email collection, sending or verification.
`core/password-vault.js` provides tested password-wrapped keys,
bounded unlock lifetime and abortable unlock contexts. Authentication now persists
and uses those wrappers, with guarded revisions, lock, restart and password
rotation. New local customer source configuration, resolver mappings, artwork,
quarantine and stream caches now use the vault. Adapter results and source-response
caches are guarded against lock races. Customer usernames are stored as opaque
lookup digests plus password-vault-encrypted profiles. Source and library names,
profiles and output credentials are also password-vault encrypted. Canonical media
metadata remains a shared graph, scoped to authorized source/library relationships.
The administrator workspace remains at `/admin`; customers use `/workspace`.

## Authentication

- Usernames are case-insensitive, 3-32 ASCII letters, digits, dots, underscores
  or hyphens, beginning with a letter or digit.
- New passwords are 8-128 characters with at least one number and one special
  character, stored with a unique salt and scrypt
  (`N=131072`, `r=8`, `p=1`). A bounded single-worker queue limits hashing memory.
- Random sessions expire after seven days, with at most 16 sessions per account.
  Only session digests are stored. Cookies are HttpOnly, SameSite=Strict and scoped
  to the Boss path. HTTPS `PUBLIC_BASE_URL` enables Secure cookies.
- Mutations require the configured public Origin and a session-bound CSRF token.
  Neither session credentials nor admin tokens are written to browser storage.
- Registration returns a recovery code once. Its keyed digest is stored, not the
  code, and it cannot decrypt a vault. Confirmed recovery deletes every old source
  and library, creates a fresh empty vault, revokes sessions/links and returns a
  new recovery code. Password changes preserve encrypted data by rewrapping the
  data key, rotate the recovery code and revoke web/output sessions.
- Vault unlocks are in memory only and expire independently of web sessions.
  Lock, logout, restart and password changes require password login again.
  The management API returns 423 when locked; account status remains available.
  Legacy accounts without a wrapper require explicit migration.
- Customer output access now also requires an unlocked vault, including existing
  output sessions and private installation links. Old in-flight library contexts
  cannot revive after re-login. This blocks new BOSS requests, not direct URLs
  already handed to players. Installation credentials are encrypted and can be
  rotated from the workspace.
- Sign out everywhere revokes web sessions. It does **not** revoke installation
  URLs already supplied to players. These are independent playback credentials;
  remove the source/library to revoke those URLs. Output credential rotation needs
  its own workflow and is not implied by changing a website password.

The password parameters follow the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
Cookie and CSRF choices follow the [session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
and [CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Ownership And Network Access

Customer ownership is persisted separately from media identity. A reliable identity
can still deduplicate in the canonical graph, but source mappings, metadata views,
resolvers, categories and outputs are restricted to the requested library.
Customers can create at most 32 sources and 64 libraries. Merged libraries accept
only that customer's enabled sources. Existing administrator sources/libraries
remain unassigned; signup never grants access to them. Global identity review is
administrator-only. Source credentials are not returned by management APIs.

Customer sources must use public HTTP(S) endpoints. Socket-level DNS checks reject
private, loopback, link-local, reserved, mixed public/private answers, local server
addresses and the configured Boss hostname. The policy follows source factories,
deferred catalogue iteration, playback and child resource requests. Admin-managed
LAN sources retain their previous behavior. Customer WebDAV shares therefore need
an authorized, publicly reachable endpoint; signup does not expose the VPS LAN.
No customer-supplied plugin code is executed. No torrents or media transformations
are introduced.

## Limits And Proxy Trust

Authentication limits persist as keyed buckets: 20 attempts/minute per peer,
five registrations/hour per peer, and ten failed login/recovery/password attempts
per username and operation per 15 minutes. Successful login clears its username
bucket, not its peer bucket. Customer management allows 240 requests/minute,
including at most 60 mutations/minute. Buckets are bounded and expire; responses
use 429 and Retry-After. Playback retains independent resolver/provider limits.

By default Boss trusts only the socket peer. `BOSS_TRUSTED_PROXY_IPS` accepts up to
32 **exact immediate-proxy IP addresses**, not broad CIDRs. Only those peers may
supply a single valid `X-Boss-Client-IP`. Boss ignores X-Forwarded-For, X-Real-IP
and CF-Connecting-IP directly. NGINX must overwrite the Boss header, not forward a
client-supplied value. IPv4-mapped addresses are normalized; malformed/duplicate
forwarding values fall back to the socket peer.

`ops/customer-release/bosstunnel.conf` configures the deployed **loopback-only
Cloudflare Tunnel origin**, not a public listener.
It trusts the local connector's CF-Connecting-IP in this location only and sends
the resulting address to Boss. Set the application trust to the measured Docker
gateway peer for this deployment. Do not guess that address or trust all Docker
networks. For public NGINX origins, use verified Cloudflare ingress ranges and
block direct origin traffic instead of copying the loopback configuration.
See [NGINX real-IP behavior](https://nginx.org/en/docs/http/ngx_http_realip_module.html)
and [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

## Release Verification

The deployed release passed an exact-image schema-10-to-16 migration against a
verified 340,417-item production snapshot, a schema-16 backup verification,
Secure/HttpOnly/SameSite cookie checks, forged-forwarding tests and public HTTPS
signup/source-authentication/deletion checks. It runs on `0.0.0.0:3000` under PM2;
the host port is loopback-only and isolated from Saint TV.

Current automated coverage includes destructive recovery/restart/expiry, persistent throttles,
cross-account ownership, source disable/edit preservation, private egress denial,
cookie/CSRF behavior, forged forwarding and desktop/mobile browser workflows.
The isolated NGINX candidate fixture verifies two client limits, forwarding
overwrite and malformed-header fallback without changing the live server.
Restore locally revokes stored web/output sessions before publishing a new copy;
see `RECOVERY.md` for the separate risk of restoring older playback credentials.
Account deletion and playback-credential rotation are available in the workspace.
The schema-16 release is published under MIT at
`https://github.com/bradfran-hub/bosstunnel`.

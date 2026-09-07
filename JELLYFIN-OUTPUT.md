# Jellyfin Output Work

Status: local experimental authenticated catalogue and original-media playback API, not a complete Jellyfin server. Routes are disabled unless `BOSS_JELLYFIN_OUTPUT=true`. Production is unchanged and remains on schema 10; this working tree uses schema 12. See `ROADMAP.md` for outstanding release gates.

## Implemented

`protocols/jellyfin.js` maps the authorized OutputLibrary into Jellyfin item DTOs using item-kind constants from the installed official `@jellyfin/sdk`. Canonical UUIDs are formatted as stable 32-character item IDs; source IDs, credentials and resolver resources are not serialized. Movies, series, seasons, episodes and live channels have metadata mappings, with an event-kind mapping reserved for live events.

Metadata includes external identities, runtime ticks, declared genres and available series/season relationships. Pagination is bounded to 200 items and uses persistent graph queries. Search uses the canonical search engine with current library scope. Totals use the same SQL filters as pages without hydrating media records or counting only the current page. Clients can disable counts with `enableTotalRecordCount: false`. Unknown item types and invalid pagination fail explicitly. No watched status, artwork tag, media stream or playback capability is fabricated.

Parent browsing defaults to seasons under a series and episodes under a season. Explicit episode browsing under a series remains available. Both parent authorization and child source scope are enforced; season filtering uses persistent episode relationships. Broader recursive folder semantics and sort/filter options remain incomplete.

Authenticated views expose nonempty Movies, Series and Live TV collections. Their IDs are deterministic for the Boss collection and content type, independent of display names or catalogue refreshes. View counts and contents use the same scoped graph. A view belonging to another Boss collection is not a valid parent in the current library. Selecting a movie view with channel item types returns no items rather than escaping the view.

The catalogue component test uses Jellyfin's official Items API client to verify movie browsing, pagination, excluded-source search isolation and episode relationships. It also checks live-channel DTO fields. A separate server-route test now verifies real SDK login, scoped browsing, logout and reauthentication. Neither test certifies a Jellyfin app or proves live playback.

References: [official BaseItemDto contract](https://typescript-sdk.jellyfin.org/interfaces/generated-client.BaseItemDto.html) and [official query result contract](https://typescript-sdk.jellyfin.org/interfaces/generated-client.BaseItemDtoQueryResult.html). Installed SDK declarations are the version-specific implementation reference.

## Authentication Storage

Schema 11 adds protocol-scoped `OutputAccounts` and `OutputSessions`. `core/output-auth.js` provisions random high-entropy output credentials independently of admin and upstream credentials. Passwords and bearer tokens are stored only as SHA-256 hashes; the clear password is returned once when provisioned or rotated. User IDs remain stable across credential rotation. Device identifiers are hashed.

Sessions default to 24-hour expiry with a maximum of 32 active devices per account. Reauthentication replaces a device's prior session. Tokens bind account and collection revisions; verification checks current library availability. Logout deletes one token, rotation removes all sessions for that output account, and collection deletion cascades to its accounts/sessions. Protocol checks prevent a Jellyfin token from authorizing a different output adapter. These storage primitives do not enable Emby or Plex output protocols.

Tests cover restart, expiry, session limits, revocation and schema-10 migration with stable media IDs. After restoring an old backup, revoke restored output sessions before exposing those endpoints, since snapshots can predate logout or rotation.

## Experimental HTTP Routes

With the feature flag enabled, an administrator can POST `/api/libraries/{id}/outputs/jellyfin` to create output credentials. An explicit `?rotate=true` rotates the password and revokes that account's sessions. Responses contain the configured Jellyfin base URL and a one-time password, use private/no-store caching, and declare playback according to the library's source capabilities. This is not a guarantee that every item has a compatible stream. These actions require the existing admin header; players never receive the admin token.

Under `/jellyfin`, implemented routes are POST `/Users/AuthenticateByName`, POST `/Sessions/Logout`, GET `/Users/Me`, GET `/Users/{id}`, GET `/Items` and GET `/Items/{id}`, including scoped `/Users/{id}/Items` aliases. Login parses bounded request bodies and MediaBrowser device metadata. Existing SDK tokens on password login do not replace credential checks. Authenticated requests accept one token from MediaBrowser, X-Emby-Token or api_key; conflicting/duplicate credentials are rejected. Queries for a different user fail with 403. Unsupported filters/operations fail explicitly.

Failed login attempts are bounded by the existing AuthLimit policy using the direct socket peer, never untrusted forwarding headers. Behind a reverse proxy this can group customers together; edge-aware per-client controls remain a deployment gate. Browser preflight permits required authentication headers. Redact bearer tokens and query strings in proxy/application logs.

`test/jellyfin-http.cjs` uses the official SDK against these server routes and the provisioned base URL. It checks scoped reads, logout/relogin, membership revocation, credential ambiguity, CORS, failed-login throttling and feature-flag disabling. Transcoding permissions remain false. Media playback permission now follows declared source capabilities; app-level integration remains unverified.

Discovery now implements GET `/System/Info/Public` and an empty `/Users/Public` list, plus authenticated `/System/Info`. ProductName/ServerName identify Boss Media Servers, Version is the actual Boss package version, and LocalAddress is the configured public base path. Public discovery contains no account list or library names. Authenticated GET `/UserViews` and `/Users/{id}/Views` expose the virtual collections; their IDs can be used as Items parents or read as item records. Official SDK tests cover discovery and view browsing. Real clients may apply Jellyfin product/version requirements; do not claim their acceptance without testing, and do not spoof a verified server version.

## Authenticated Artwork

Item records now include opaque HMAC image tags for authorized Primary, Backdrop, Logo and Thumb resources. Tags change when the selected resource or source revision changes; they expose neither source URLs nor credentials. Live channels can use their logo as the primary image when no poster exists.

GET/HEAD `/Items/{id}/Images/{type}` and index-0 image routes use the authenticated session and current library/source scope. A single backdrop is currently supported. The proxy forwards only configured source headers, retains existing cross-origin redirect stripping, and checks the session before upstream work and during delivery. Logout or revocation interrupts an in-flight transfer.

Original image bytes are preserved. JPEG, PNG, WebP, GIF, AVIF and BMP MIME types are allowed, with an 8 MiB response bound. HTML, SVG, playlists and unsupported types are rejected. Max-width/height hints are accepted but no resizing is performed; other transformations fail explicitly. Responses are private/no-store with nosniff. Public resource-ticket URLs are not issued for these images.

Official SDK tests verify tags, primary/backdrop bytes, HEAD, missing indices, tag changes, content-type/size rejection and logout interruption. Pending upstream readers now cancel promptly on abort, verified by a dedicated regression. These image routes remain experimental and undeployed.

## Original-Media Playback

GET/POST `/Items/{id}/PlaybackInfo` calls the independent canonical resolver only
when requested. Browsing does not resolve streams. The response contains at most
eight compatible HTTP/HLS candidates and a playback session ID. No compatible
result returns `MediaSources: []` with `ErrorCode: NoCompatibleStream`.

Device direct-play profiles constrain declared containers, codecs, bitrate,
audio channels and supported profile conditions. Required unknown facts fail
conservatively. Unsupported profiles do not cause transcoding. Source metadata
is not a substitute for probing every actual codec/container variant.

Media sources expose an authenticated `/Videos/{id}/stream` URL requiring
`Static=true`, the returned `MediaSourceId`, `PlaySessionId` and output token.
GET/HEAD and byte ranges preserve the original source bytes. Non-static requests
and transformations are rejected. A stale playback resource requires fresh
playback information; automatic URL renewal is not implemented here.

HLS child and external subtitle links use encrypted session-bound resource
tickets. Session expiry, logout, password rotation, library changes, source
revocation and stopped playback revoke access, including in-flight media reads.
Upstream credentials never become player credentials. Subtitle MIME types and
response size are constrained; lookup cancellation has a four-second overall
budget, including source startup and queue waits. It does not cancel another
caller's shared source initialization.

Only declared external SRT/VTT/ASS/SSA subtitles are exposed. Embedded extraction,
subtitle burning, audio remapping, remuxing and transcoding are absent. Unknown
embedded track indices are not invented. The current direct-play profile subset
is deliberately conservative, not a full replacement for Jellyfin's media engine.

The wire contract follows the installed official SDK and
[PlaybackInfoDto](https://typescript-sdk.jellyfin.org/interfaces/generated-client.PlaybackInfoDto.html).

## Playback State And Navigation

Schema 12 adds `OutputUserData` and encrypted `OutputPlays`. Favourites, played
flags, resume position and play count persist per output account and canonical
item. Accounts are currently one per Boss collection/protocol; this is not a
multi-profile household-user system. Reliable canonical merges preserve the most
recent user choices and combined play counts. Pending plays are capped at 64 per
session and expire after at most twelve hours or the authentication expiry.

POST `/Sessions/Playing`, `/Sessions/Playing/Progress` and
`/Sessions/Playing/Stopped` accept the returned play session and authorized item.
Repeated starts count once. A stop records position and revokes its resource
links. POST/DELETE `/UserFavoriteItems/{id}` and `/UserPlayedItems/{id}` update
state. User reports are not verified decoded playback or reliability evidence.
Jellyfin transfers are not yet aggregated into the shared reliability history.

GET `/Shows/{seriesId}/Seasons` and `/Shows/{seriesId}/Episodes` hydrate missing
metadata, retain source ownership, and query persistent season/episode ordering.
Episode requests support `season` or `seasonId` and bounded pagination. The
general catalogue route still rejects unsupported sorts and recursive filters.

GET `/LiveTv/Info`, `/LiveTv/Channels`, `/LiveTv/Channels/{id}`,
`/LiveTv/Programs` and `/LiveTv/Programs/{id}` project the authorized canonical
channels and source-scoped guide. Guide pages are at most 200 items, with up to
100 explicit channel IDs and a maximum fourteen-day interval within thirty days
of the current date. The default is current/upcoming programmes over seven days.
Programme IDs are deterministic and scoped to the output collection. No tuner,
recording, catch-up or timeshift service is fabricated.

Tests in `test/jellyfin-playback.cjs` exercise the official SDK, lazy resolution,
movie/episode/channel byte delivery, ranges, HLS children, subtitle isolation,
revocation, state, season ordering and guides. Graph tests cover migration,
restart, merges, queue bounds and backup validation. Generated-video integration
is available with `TEST_JELLYFIN_OUTPUT=true npm run test:playback`; use a private
test instance, not a customer library.

## Remaining Work

Client-visible live kinds are `TvChannel` and `Program`, verified against Jellyfin's [channel entity](https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Controller/LiveTv/LiveTvChannel.cs) and [programme entity](https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Controller/LiveTv/LiveTvProgram.cs). Internal SDK enum names alone are not sufficient evidence of wire behavior.

- Session/device reporting and deployment-grade edge authentication controls.
- Supported filters/sorts, recursive browsing semantics, additional artwork indices and optional image transformations.
- Broader direct-play profile evaluation and candidate expiry/failure recovery without changing media bytes.
- Embedded tracks, full subtitle selection semantics and optional richer user-state APIs.
- Tuner lease lifecycle and dynamic live resources. `MEDIA-SERVER-SOURCES.md` describes the limited live input now implemented locally.
- HLS session-level reliability accounting; HTTP output evidence integration.
- Actual official-player connection, movie/episode/live playback, seeking and credential isolation tests behind the deployment base path.
- Separate Emby and Plex output adapters and their own official contract/client verification. This component does not imply compatibility with them.

Do not advertise Jellyfin output until the required server and client workflows are implemented and verified. Keep protocol work behind the canonical graph; do not introduce source-to-output converters.

# Jellyfin And Emby Sources

Status: movie/series inputs are deployed. The new live catalogue, guide and
already-direct-playable live-resource support is local only, not deployed.

The shared source adapter translates into the canonical graph. Jellyfin requests
use the installed official `@jellyfin/sdk`; Emby requests use its documented REST
contract. Neither source knows which output adapter will consume its records.

## Authentication And Scope

Configure the authorized server URL and API key. A configured `userId` is passed
to user-scoped catalogue, metadata, live and playback requests. Boss does not pick
an arbitrary upstream user or enumerate credentials. Requests keep a fifteen-second
deadline, forbid automatic redirects and bound metadata responses to eight MiB.

Live discovery requires an explicitly configured user and no `libraryPath`
restriction. A folder-restricted source must not silently gain access to live
channels outside that folder. Boss checks `/LiveTv/Info`, verifies that the user
appears in `EnabledUsers`, then checks channel and guide access independently.
Denied or unavailable live APIs do not imply that the VOD library is unusable.
No user, an omitted permission declaration or denied access means no advertised
live support. A denied guide omits EPG capability even when channels are available.

## Catalogue And Playback

Movies, series and episodes retain server identities, metadata and original
static playback. Known bitrate, video profile/level/depth and audio indices are
retained for client capability evaluation. Unknown values stay unknown.

Live channels are imported in bounded pages, including names, numbers, local
artwork and source-scoped EPG identities. Guide refresh pages current/upcoming
programmes over seven days; the engine publishes a successful refresh atomically.
Existing recent guide history is retained under the engine's normal policy.
Channel and guide ingestion never open tuners or fetch media bodies.

On channel playback Boss requests playback information with direct play enabled,
direct streaming/transcoding disabled and automatic tuner opening disabled. Only
HTTP resources explicitly marked directly playable, requiring no open/close
lease, are accepted. An external resource receives only the source-declared
resource headers, not Boss's Jellyfin/Emby server credentials. The canonical
resolver and proxy still enforce the no-torrent, authorization and media policies.

Sources requiring `/LiveStreams/Open` and `/LiveStreams/Close`, tuner reservation,
recording, DRM, remuxing or transcoding are not supported by this step. Their
channels can remain discoverable, but playback returns no compatible stream when
no other authorized source supplies one. This is a material limitation, not
complete live support for every Jellyfin/Emby installation.

## Verification

Deterministic tests cover both source protocols, configured-user scope, folder
restrictions, independent EPG denial, source-scoped guide ingestion, just-in-time
playback information, direct resource selection, blocked tuner/transcode/torrent
paths and cross-origin credential isolation. Existing movie/series and timeout
regressions remain in `test/canonical-sources.cjs`. No customer live server has
been certified by these fixtures.

Primary contracts: [Emby Live TV](https://dev.emby.media/doc/restapi/Live-TV.html)
and the installed official Jellyfin SDK LiveTv/MediaInfo API definitions.

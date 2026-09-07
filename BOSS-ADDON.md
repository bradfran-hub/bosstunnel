# Boss Media Addon Protocol v1

Boss uses a native `.boss` addon descriptor with extensionless HTTP API resources. It is not a renamed external addon document. Its identifier model, catalogue response, pagination and resource discovery are defined here. The native wire encoding is UTF-8 JSON with `Content-Type: application/json`; Native descriptor URLs end in `/addon.boss`; the legacy `/addon` alias remains supported. The descriptor includes an absolute `addonUrl` pointing to its hosted `.boss` URL. Other resource URLs do not require file extensions. Existing players need explicit support for this protocol, or a separate compatible output from Boss.

## Descriptor

Player-visible descriptive metadata is selected from active sources in the connected library, ordered by source priority and then source ID. Genres combine those sources' current metadata without case-only duplicates, up to 100 values. Canonical identities remain shared; a higher-priority source outside the library must not supply its title, description or genres to that library. Local text search indexes each source's current title and original title, and matches only active source mappings in the library. A result keeps the library's preferred display title even when another selected source's title matched. Renamed titles replace their previous index entries; historical aliases are not retained automatically.

`GET /bossmedia/a/{library}/addon.boss`

The response uses `Content-Disposition: attachment; filename="addon.boss"`. The App SDK accepts hosted links with `BossClient.fromAddon(url)` and local File/Blob, UTF-8 bytes or text with `BossClient.fromFile(file, { trustedOrigin, token, signal })`. Imports are limited to 8 MiB. The application must obtain explicit trust for the origin before supplying credentials; do not automatically trust a host named in an imported file. Resource URLs must stay on that origin. Files contain data only, not scripts or media. Keep private access links confidential.

```json
{
  "format": "boss-media-addon",
  "version": 1,
  "id": "library-id",
  "name": "My combined library",
  "capabilities": { "catalog": true, "streams": true },
  "resources": {
    "catalogue": "https://host/bossmedia/a/library-id/boss/catalogue",
    "media": "https://host/bossmedia/a/library-id/boss/media/{id}",
    "playback": "https://host/bossmedia/a/library-id/boss/playback/{id}"
  },
  "pagination": { "mode": "cursor", "parameter": "after", "maximumPageSize": 200 },
  "security": { "access": "private-link", "torrents": false }
}
```

Capability declarations are explicit booleans. Optional subtitles and guide resources are included only when supported. Resource templates use canonical UUID media identifiers. Descriptor URLs are bearer credentials: do not publish them or include them in analytics. Removing a library revokes its descriptor and resources.

## Catalogue and Metadata

`GET {catalogue}?type=movie&limit=100&after=cursor`

Response: `{ "items": [MediaItem], "next": "cursor-or-null" }`. Use the returned cursor unchanged. Types are movie, series, season, episode, channel and event where declared. Omitting type queries all accessible types. Optional `search` performs bounded metadata discovery through authorized sources and searches the canonical graph. No playback lookup occurs while listing or searching.

MediaItem has `id`, `type`, `title`, optional descriptive metadata, `identities` (IMDb/TMDB/TVDB), protected artwork URLs and `playbackState: UNRESOLVED`. Episodes retain canonical `seriesId`, `seasonNumber` and `episodeNumber`. `GET {media}` returns `{ "media": MediaItem }` and may hydrate metadata without resolving video.

## Live Channels and Guides

Guide refreshes are staged in bounded SQLite batches and published atomically after successful completion. Failed downloads or changed source credentials leave the previously published guide intact. Successful refreshes retire missing current/future programmes while retaining past programmes for up to 30 days of catch-up history. A guide provider should return its complete available current/future schedule, not an unlabeled partial update.

Channel metadata includes `channel.number` when known and `channel.epgId`, matching the channel identifier in the descriptor's XMLTV `guide` resource. Boss exports stable synthetic guide IDs, not an upstream provider's private identifiers. A native source imports a guide only when `epg` is declared, channel types are supported, and a guide URL is supplied. API and guide resources must remain on the configured origin; redirects are rejected and private source authentication remains origin-scoped. Guide ingestion is streamed in bounded records.

Imported guide identities are stored per source mapping so merged channels can retain different provider guide IDs. The downloadable author SDK supports an optional `guide({}, { signal })` handler returning an iterable of `{ channelKey, title, description, startsAt, endsAt }` records. Times are UTC milliseconds and channel keys match `channel.epgId`. The SDK encodes XMLTV at extensionless `/guide`, uses backpressure, and closes the stream on invalid records. Authors must respect cancellation during upstream work. EPG is declared only when channel types and the guide handler are both present.

## Catch-up

The advertised per-channel window is computed from active source mappings authorized for this library. A longer window from another library or a removed source does not apply. Refreshing a provider to a shorter window updates the advertised value; historical merged channel metadata is not authoritative for archive capability.

An optional `resources.catchup` template accepts a channel ID and `start`/`end` UTC millisecond parameters. `BossClient.catchup(id, { start, end, signal })` exposes it through native and authenticated Xtream extension connections, including M3U-discovered clients. Responses contain protected playback resources. Ordinary playback remains separate and does not select an archive implicitly.

Native sources enable catch-up only with declared channel/stream support, a catch-up resource and per-channel positive `channel.catchupDays` (up to 365 days). Source-specific windows remain in encrypted resolver mappings. The canonical resolver validates intervals, separates interval caches and checks current authorization. Intervals cannot exceed 24 hours or end more than one minute in the future. Unsupported or unavailable archives return 422. Native timeshift remains unsupported; no local DVR is created. The author SDK supports an optional catchup({ id, start, end }, { signal }) handler returning the same resource array as playback. It requires channel types, media and playback handlers. Before invoking it, the SDK validates the interval and reads the channel's current metadata to enforce its declared archive window; invalid requests never reach the archive handler. Authors must return only authorized recordings for the requested interval, or an empty array when unavailable.

## Playback Resources

`GET {playback}` returns `{ "id": "canonical-id", "resources": [{ "url": "protected-play-url", "transport": "http", "resolution": "on-request" }] }` for playable media types. A series or season returns an empty resource list.

Requesting the protected play URL invokes the independent resolver against the library's currently authorized sources and playback profile. Catalogue presence is not a promise of stream availability. HTTP 422 means no usable resource could be provided. Text documents are not playable media. Torrent URLs, engines and payloads are excluded; already-resolved authorized HTTP resources are permitted.

## Other Outputs

The same library can be exported as an Xtream login, M3U/XMLTV or Other app addon. These are independent output adapters over the graph. The compatibility addon retains the external protocol's required paths and SDK. Boss-native clients use this specification instead.

## Optional Player Capabilities

The Boss gateway advertises `playbackCapabilities` with version `1`, a `parameters`
map, supported `codecs`, and `maximumHeight`. This is optional and separate from
transport protocol negotiation. Author-hosted addons must not claim it unless
they implement its validation and enforcement; the author SDK does not advertise
it automatically. Clients must not assume every `.boss` source supports it.

The app SDK accepts `capabilities` on `playback` and `catchup`. Fields and wire
names are `codecs` / `boss_codecs`, `maxHeight` / `boss_max_height`, `hdr` /
`boss_hdr`, `strictCapabilities` / `boss_strict`, and `language` / `boss_language`.
Codecs are a nonempty, unique array in the SDK and a comma-separated list on the
wire. The gateway supports h264, hevc, av1, vp9, mpeg2video and mpeg4. Height is an
integer from 0 through 8640; 0 adds no player limit. Booleans use exactly `true`
or `false` on the wire. Language is a bounded language tag, normalized lowercase.
Malformed or duplicate values return 400. Unsupported SDK requests return 422
before network access.

The gateway intersects player and library codec/height restrictions; HDR is
allowed only if neither prohibits it, and either can require known codec data.
Language ranks candidates rather than excluding all other languages. A player
language preference takes precedence over the library default. Contradictory
codec restrictions return 422 without contacting sources. The gateway preserves
only player options on generated playback URLs, so retained links cannot freeze
or weaken a subsequently changed library policy. A policy revision during
resolution returns 409. Resolution remains lazy and source-authorized.

These are metadata-based filters, not media analysis or format conversion.
Strict codec filtering rejects unknown codecs, but absent height/HDR metadata
still cannot prove compatibility. The player remains responsible for decode
errors. The HTTP contract is identical through the native API and Xtream
extension; Boss-aware M3U connections discover the same native API.

## Optional Categories

When `capabilities.categories` and `resources.categories` are declared, GET the resource with `type`, optional `after`, and `limit` (1 to 200). The response is `{ categories: [{ id, name, type }], next }`. Native gateway category IDs equal Xtream category IDs. Author-hosted source IDs may be arbitrary stable strings of at most 256 characters; names are limited to 1024 characters. Types are movie, series, channel and event.

Pass `categoryId` to catalogue or search to filter membership. A media record may contain its primary `category`; this is not a complete membership list. Filtered catalogue records carry the selected category. Category cursors and media cursors are separate. Gateway category `1` is the uncategorized group, not the whole library.

The source adapter imports root feeds plus independently checkpointed category feeds, so a title can retain every category membership without duplicate canonical records. Refresh retires removed feeds and their membership. Category discovery is metadata-only, limited to 4096 unique feeds across types and a 15-second deadline, with at most 200 categories per response. Malformed, repeated or oversized discovery fails rather than silently dropping memberships. Only root feeds participate in expanded search.

Native and Xtream-extension category APIs expose all authorized memberships. Ordinary M3U carries one primary group per entry; episode entries inherit their series' primary group. Boss-aware M3U clients use descriptor discovery to access the full category API. No claim of lossless multi-category behavior is made for legacy playlist players.

# WebDAV Source Contract

Boss WebDAV is an input adapter into the canonical graph, not a separate player
or a collection of point-to-point converters. Native Boss, Xtream, M3U and the
external compatibility addon read the same authorized media identities.

## Authentication And Discovery

- HTTPS Basic username/password, Bearer `apiKey`, or anonymous access. When both
  credential forms are supplied, Basic takes precedence. Digest, OAuth login
  flows and interactive browser challenges are not implemented.
- Validate the configured root with an authenticated depth-zero PROPFIND before
  accepting a source. Scan depth-one collections recursively; nesting is limited
  to 64 directories and requests have a 30-second deadline.
- Reject off-origin/root escapes, encoded separators, torrent resources and
  unreadable directory entries. Scan failure does not retire previous items.
- Stage unordered listings in a private temporary SQLite database with bounded
  batches and a 2 MiB SQLite cache. Staging uses `DATA_DIR` in production, not
  memory-backed `/tmp`; standalone use falls back to the OS temporary directory.
  Persistent canonical records and source
  mappings live in the normal Boss database. Cancellation removes the staging DB.
  An ungraceful process/container kill may leave a private `boss-dav-*` staging
  directory; remove abandoned staging only when no WebDAV scans are running.
- Recurring source refresh uses the existing scheduler; newly found episodes are
  indexed in the catalogue scan itself. There is no fixed title-count cap.

## Identification

- Movie names are cleaned of common release/quality suffixes. A filename year
  and explicit `[imdbid-tt1234567]`, `[tmdbid-123]`, `[tvdbid-123]` tags are retained.
- Series support `S01E01`, `1x01`, season zero, season folders and `tvshow.nfo`.
  Bounded ranges such as `S01E01-E03` create multiple episode entries referencing
  one complete file, without fabricating time offsets.
- Local `movie.nfo`, `tvshow.nfo` and matching video-basename NFO files provide
  titles, descriptions, years, genres, ratings, runtime, identities and episode
  numbering. NFO is parsed with SAX, bounded to 1 MiB/32 levels/10,000 nodes, and
  document types are prohibited. Invalid optional NFOs fall back to filenames;
  authentication/rate-limit errors interrupt the scan.
- Local posters, fanart, logos and thumbnails are authenticated resources.
  Source-local NFO artwork takes priority. Generic movie-folder art applies only
  to a folder containing one video. Flat libraries use basename-specific art.
- Detail requests may fill missing metadata through the existing Cinemeta helper.
  Matching needs an IMDb identity or an unambiguous exact title/year match.
  Provider failure falls back to indexed metadata. Series lookup never imports
  episodes absent from WebDAV. Remote metadata is not a playback entitlement.
- Reliable identities deduplicate across sources. Filename paths are stable source
  keys, not guaranteed persistent file IDs after a rename. Ambiguous names and
  nonstandard absolute/date-based episode numbering are not guessed.

## Playback And Outputs

- The resolver fetches the indexed authorized file on playback, supplying source
  credentials server-side. No media download is performed during catalogue scan.
- Recognized video extensions: MP4, MKV, M4V, WebM, MOV, AVI, MPEG, MPG, TS,
  M2TS, MTS, OGV, FLV, 3GP and M3U8. An extension is not proof of codec support.
- Matching external SRT/VTT/ASS/SSA subtitles are discovered on request and
  proxied through revocable Boss resource links. Embedded tracks remain in the
  original file. Legacy Xtream/M3U players do not gain external-subtitle APIs or
  expanded search unless they consume the Boss extension.
- No remuxing, transcoding, torrents, DRM bypass, live TV or fabricated EPG.
  Startup/seek latency depends on WebDAV, the network, Cloudflare and the player.

## References And Verification

- [WebDAV RFC 4918](https://www.rfc-editor.org/rfc/rfc4918.html)
- [Local NFO metadata](https://jellyfin.org/docs/general/server/metadata/nfo/)
- [Provider identity filename tags](https://jellyfin.org/docs/general/server/metadata/identifiers/)
- `test/webdav.cjs`: authentication, hierarchy, metadata, cross-source identity,
  safe paths, bounded scan, failure preservation, restart and HTTP outputs.
- `test/playback-client.cjs`: generated MP4/MKV movies and episodes through the
  actual HTTP outputs, unchanged media bytes and decoded moving video frames.
- Public app contract: `/bossmedia/sdk#webdav`.

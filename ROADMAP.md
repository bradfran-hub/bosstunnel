# Boss Completion Roadmap

Updated 2026-09-07. **Not complete.** This file separates implemented work from
release gates. `COMPLETION-AUDIT.md` retains detailed historical evidence.

## Scope And Production

- Boss server, canonical graph, source/output adapters, `.boss` SDK and website only.
- No player-app work, torrents, DRM/authentication bypass, remuxing or transcoding.
- Production is `bosstunnel:20260907-customer-accounts`, schema 16, at
  `https://bosstunnel.com/`. The PM2 process binds `0.0.0.0:3000` inside
  its container. Do not take Saint TV's host port or use `saint-tv.com`.
- Customer account creation and password-only vault storage are deployed. The
  separate Jellyfin/DASH output work remains experimental and disabled unless
  explicitly enabled.
- Direct-only playback is deployed from `/root/bosstunnel-open-source`:
  exact upstream URLs/headers for native choices, empty 307 redirects for
  ordinary IPTV playback, no video fetch/relay or HLS rewriting. Header-only
  sources require a capable player; redirect-only outputs still return the exact
  URL, after which the upstream may return 401 if the player cannot apply headers.
  The experimental local proxy/DASH work is superseded, not a release target.
- Keep existing catalogue content and daily new-release scanning. The earlier
  100,000-per-type bulk-import target was superseded by the user.

## Implemented Foundation

- Source -> canonical graph -> resolver -> output, not pairwise converters.
- Persistent canonical/external/synthetic identities, reliable deduplication,
  metadata-first catalogues and just-in-time authorized playback.
- Merged multi-source libraries; existing Boss, Xtream, M3U/XMLTV and external
  addon compatibility outputs. Capabilities remain source/protocol-dependent.
- `.boss` app/author SDKs, expanded-search discovery and source-scoped categories.
- Persistent ingestion, bounded paging/caches, daily metadata scanning, source
  revocation, encrypted credentials and local backup/restore verification.
- WebDAV recursive movie/episode indexing, NFO/artwork/subtitle discovery and
  original-file playback. See `WEBDAV.md` for authentication/naming limits.
- Public MIT source is published at `https://github.com/bradfran-hub/bosstunnel`.
  The independent release tree is `/root/bosstunnel-open-source`, not this
  experimental schema-15 tree. Root homepage, `/workspace` and `/sdk` are live.
- Native playback exposes optional Automatic redirects and direct per-provider choices with
  known quality tags. Live input comparisons preserved 10/10 and 9/9 streams;
  a merged example exposed 17 choices plus Automatic. EPG import from BOSS
  sources and export through the native SDK have deterministic and live evidence.

## New Local Work

- Jellyfin output: authentication, discovery, scoped views/catalogue/artwork,
  resolver-backed exact HTTP/HLS resources, direct-play profile subset,
  required provider headers and bounded subtitle lookup. Protected artwork is
  not usable by an unmodified URL-only image client without upstream URL auth.
- Schema 12: persistent favourites, played state, resume positions, play counts
  and bounded encrypted playback sessions; migration/restart/merge tests.
- Jellyfin season/episode navigation and channel/guide routes through the graph.
- Jellyfin/Emby live input: configured-user discovery, paged channels/EPG and
  JIT selection of already-direct-playable resources. Tuner leases remain absent.
- Static DASH opt-in has separate local evidence in `DASH-IMPLEMENTATION.md`.
- Customer signup/login without email, rotating recovery codes, scoped cookies,
  persistent throttles and source/library ownership. Public-only customer egress,
  explicit reverse-proxy trust and responsive browser workflows are implemented
  in production. See `CUSTOMER-ACCOUNTS.md`.
- Password-only vault primitive: per-user wrapped data keys, authenticated
  owner/record binding, fixed in-memory unlock lifetime and abortable contexts
  are implemented locally. Schema-14 account wrapper persistence, guarded login,
  atomic password rewrap, restart/restore locking, destructive recovery and locked
  workspace UI are implemented. New customer source configuration, mappings,
  artwork, quarantine, resolver/source-response caches and adapter unlock guards
  are integrated locally. Output session checks, shared library access and lazy
  playlist/guide exports now reject locked/stale access. Profile/metadata/output
  credential protection are complete for customer-owned records; see
  `PASSWORD-VAULT.md`. Administrator-owned legacy records remain server-key based.
- Customer-containing output-play records now encrypt each provider choice with
  its source key, bound to output protocol, token hash and play identity. Locked
  and server-key fallback reads are refused; personal watch-history storage and
  installation-link privacy and rotation are implemented.

Current release verification: 201 backend tests and 103 syntax checks. Earlier
experimental verification also covered 60 generated playback cases with
40 moving decoded frames each and unchanged media bytes. Ten Jellyfin cases also
matched five original frames after seeking. Those proxy-era fixtures are not
evidence for the direct-only production contract and must not re-enable relaying.
These checks do not establish live tuner support, third-party player acceptance
or a production release of the experimental tree.

## Outstanding Deliverables

1. Finish server-compatible outputs. Jellyfin still needs broader navigation,
   supported client profiles, session/device workflows, expiry recovery and
   official-client acceptance. Emby and Plex outputs are not implemented. Define
   and verify each supported server contract independently; do not relabel one
   adapter and claim full compatibility. Dedicated Nuvio support also needs a
   verified available protocol contract. Plex live input needs separate work.
2. Complete source lease lifecycle. Add canonical acquisition/release for live
   tuners, cancellation, failed opens, abandoned sessions and restart cleanup.
   No tuner should be reserved merely because a catalogue item is browsed or a
   candidate is ranked. Verify live access and upstream connection limits.
3. Finish direct-playback reliability. Retain stable provider identifiers where
   supplied, publish explicit expiry/compatibility information and test client
   retry guidance. New direct handoffs cannot produce server-side segment/byte
   evidence or automatic fallback after redirecting. Do not reintroduce a media
   relay to obtain evidence; any future client reports must be clearly untrusted.
4. Complete DASH coverage. Dynamic refresh, alternate representations/audio,
   expiry, live/episode output coverage and deployment remain separate gates.
   Unsupported DRM or media transformations must fail explicitly.
5. Complete identity adjudication. Implement authenticated, auditable decisions
   for quarantined identities and explicit relationships/season offsets. Preserve
   synthetic IDs and avoid forced merges of incompatible series definitions.
6. Complete off-server recovery. Destination and privately configured credentials
   are still needed. Implement encrypted scheduled retention, independent-key
   recovery and a tested restore on a separate instance. A local backup is not
   off-site evidence.
7. Complete edge controls and release. Verify trusted proxy/client identification,
   per-client abuse limits, redacted paths/tokens and output credential handling
   behind NGINX/Cloudflare. Test the exact candidate image with PM2 on port 3000,
   its migration on a verified copy, existing synthetic IDs/library memberships,
   backup restoration and explicit rollback. Then deploy and probe public APIs.
8. Customer account release: complete for the current scope. Password-wrapped
   vaults, encrypted customer records, lock/restart behavior, destructive recovery,
   deletion, output credential rotation, backup session revocation, edge checks,
   exact-image migration and public signup are deployed. This does not claim
   immunity from compromise of an unlocked running process.
9. Continue public onboarding and developer services. Get Started now opens the
   customer workspace, and desktop/mobile flows are verified. The read-only
   developer MCP is deployed with official-client, final-image and browser
   verification; it exposes public SDK docs only. The original
   user-supplied official badge artwork remains unavailable. BOSS-input versus
   export-only workspace intent still needs clarification before removal.

## Completion Criteria

Every advertised protocol/type must pass owned deterministic source -> graph ->
output fixtures, authentication/revocation checks and original-media playback
tests. Each supported third-party client workflow needs its own connection,
navigation and playback evidence; universal or lossless compatibility must not be
claimed from DTO tests. Publish unsupported capabilities in SDK documentation.
Production completion requires the exact-image release and recovery gates, not
just a passing local test suite.

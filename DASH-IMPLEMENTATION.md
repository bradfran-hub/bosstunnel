# DASH Delivery Work

Status: incomplete and not deployed; production playback still selects HTTP/HLS only. Local playback supports explicit DASH opt-in through the canonical resolver. This is not universal player certification.

## Completed Component

`core/dash-document.js` uses the existing SAX dependency to parse bounded MPD documents and serialize their structure. Limits default to 2 MiB, 50,000 structural/text nodes and 64 levels. Parsing preserves namespaces, attributes, timeline values and segment-template expressions. Protected content, document type declarations, external entities and XLink fragments are rejected. Errors omit source URLs. No network requests occur during parsing.

The relevant protocol reference is the [DASH-IF interoperability guidance](https://dashif.org/docs/DASH-IF-IOP-v4.2-clean.htm), including MPD URL resolution, segment addressing and content-protection signalling. Parsing an MPD is not sufficient to deliver its referenced media securely.

`core/dash-template.js` compiles serializable resource templates for later encryption inside existing Boss tickets. It binds RepresentationID and Bandwidth from server-side representation metadata, supports Number/Time substitutions, decimal zero-padding up to 20 digits and escaped dollar signs, and uses exact unsigned 64-bit integer validation. Player parameters cannot change the compiled origin or introduce arbitrary URLs, headers or representation IDs. Unknown/duplicate parameters, unsupported expressions, fragments, prohibited URLs and overflow are rejected. Template compilation and expansion perform no network requests. The local resource-ticket route now supports compiled templates through core/resource-ticket.js. Tickets encrypt headers and templates and bind collection/source revisions, current source membership and expiry. HTTP tests verify segment delivery, byte preservation, parameter rejection before upstream access and source revocation. MPD rewriting, addressing inheritance, timeline constraints and real DASH playback remain incomplete; this work is not yet deployed.

## Required Delivery Work

The local MPD rewriter and proxy now handle one inherited BaseURL per level, inherited SegmentTemplate/SegmentList/SegmentBase addressing, initialization/index references, decimal template expressions and byte-range attributes. Credentials are included only for resources on the fetched MPD's origin. Full MPD reload uses the original request URL; Location/PatchLocation hints are removed. Multiple BaseURL alternatives, UTC timing, content steering, xml:base, subrepresentations and special BaseURL availability/range attributes currently return explicit unsupported errors rather than partially rewritten media.

`npm run test:dash-playback` generates a three-second H.264/AAC clip and DASH segments locally, then serves them through encrypted MPD/resource tickets with authorization headers. The current run decoded 30 identical video frames and matched a five-frame seek against the original clip. Decoded mono audio matched the authorized upstream DASH response exactly (145,408 samples), including a one-second seek result (48,000 samples). Audio uses the upstream DASH baseline so fixture packaging timestamps and AAC priming are identical on both paths. Initialization and first media segments for both tracks were byte-identical (four resources). The fixture bypasses normal resolver/output entry points and does not certify adaptive bitrate switching or broad player support. `artifacts/dash-playback.json` records current results. The main suite has 110 passing tests, including inherited addressing, credential isolation, segment lists and ranges. Production is unchanged and DASH selection remains disabled.

- Complete alternative BaseURL handling and explicitly scoped support for additional MPD addressing features.
- Extend real-player coverage beyond the tested audio/video templates to SegmentList, SegmentBase and adaptive bitrate switching across multiple video representations.
- Bind template substitutions to encrypted resource tickets. Do not accept arbitrary player-supplied URLs, headers, paths or representation identities.
- Preserve authorization and credential-origin boundaries through redirects and cross-origin media references. Continue rejecting torrents and DRM resources.
- Handle dynamic MPD refresh and resource expiry without turning temporary URLs into permanent catalogue data.
- Extend canonical resolver integration beyond the verified native and M3U-listed Xtream movie links to episode, live and external compatibility output workflows. Do not create source-to-output pairwise converters.
- Add real generated-video tests through native Boss, Xtream, M3U and external compatibility output links. Verify seeking, byte preservation, credential isolation, cancellation, expiry and malformed or protected MPDs.

## Local Client Protocol Negotiation

Playback URLs accept `boss_protocols` as a single comma-separated query parameter containing unique values from `http`, `hls`, and `dash`. Missing parameters retain the HTTP/HLS default. Empty, duplicate, unknown or repeated values return HTTP 400. Clients must opt in only to protocols they can decode; a file-name extension does not change the returned media container. Local descriptors advertise `playbackNegotiation`, and the app SDK accepts `playback(id, { protocols, signal })` and the same option for catchup. The SDK rejects explicit preferences when negotiation is not advertised. These changes and the updated SDK page are not yet deployed.

The generated fixture verifies full audio/video decode through native, M3U-discovered and authenticated Xtream SDK connections. All three preserve the requested protocol on their playback links. This is local contract and fixture evidence, not certification of an external player or arbitrary upstream media.

The generated audio/video fixture now also discovers a native Boss playback link and a movie link in the M3U playlist, then plays both through the canonical resolver with `boss_protocols=dash`. Full decoded video and audio and seek results match the fixture baselines. Without opt-in both links reject the DASH-only source with HTTP 422. The M3U movie link exercises the actual Xtream playback route. This supersedes the resource-route-only scope above; adaptive bitrate switching, dynamic MPDs, episode/live workflows and public client certification remain unverified.

Only deploy and advertise DASH after the remaining delivery and client tests pass. Media bytes must remain unchanged; this work does not introduce transcoding or remuxing.

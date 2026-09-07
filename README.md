# BossTunnel

Open-source BOSS protocol, app SDK, addon SDK and canonical media gateway.
Original code and protocol documentation are licensed under [MIT](LICENSE).

- Website: https://bosstunnel.com
- App integration: https://bosstunnel.com/sdk
- Addon authors: https://bosstunnel.com/sdk/addons
- Protocol specification: [BOSS-ADDON.md](BOSS-ADDON.md)
- Developer MCP: `https://bosstunnel.com/mcp` (Streamable HTTP)
- App SDK: [public/boss-client.mjs](public/boss-client.mjs)
- Addon SDK: [public/boss-addon.mjs](public/boss-addon.mjs)

## Architecture

Source adapter -> persistent canonical media graph -> resolver -> output adapter.

The catalogue stores metadata and stable identities separately from playback.
Playback is resolved on request using the connected library's authorized sources.
Synthetic Xtream IDs persist across restarts. Library merging, pagination,
source-scoped metadata, categories, extended search, subtitles and XMLTV guides
share the same graph. A title in a catalogue is not a promise of playback.

Inputs include BOSS addons, Xtream, M3U/XMLTV, Jellyfin, Emby, Plex, WebDAV,
and compatible Other sources/catalogues. Released outputs are BOSS, Xtream,
M3U/XMLTV and Other app compatibility addons. Capabilities depend on the source.
This release does not implement Plex/Emby/Jellyfin server impersonation.
Legacy players cannot gain extended search without implementing the BOSS SDK.

No torrent engines, acquisition, remuxing, transcoding, DRM bypass or subscription
bypass. Authorized direct/debrid HTTP resources may pass through unchanged.
The `.boss` descriptor is a data file, not an executable or media container.
Its HTTP encoding is UTF-8 JSON. Resources are discovered, not guessed.

## Run The Gateway

Use Node.js 22 or Docker with Compose. Copy `.env.example` to `.env`, generate
two independent secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
and configure your own HTTPS public URL. Keep the encryption key with private
backups; changing it makes stored source credentials unreadable.

```sh
docker compose up -d --build
```

The application runs under PM2 at **0.0.0.0:3000** inside the container.
The host port is restricted to the local NGINX proxy. The example
[NGINX configuration](nginx/boss.conf.example) is for a Cloudflare Tunnel origin.
Use your own tunnel and DNS configuration, preserving other applications' routes.
Do not expose an unencrypted administration endpoint on the public Internet.
Keep access logs free of credential-bearing URLs and query strings.

For a direct Node deployment, install dependencies with `npm ci`, set the same
environment variables in your process environment, then use `npm start`.
The admin token unlocks source/library management; this release is an
administrator-managed gateway, not a public customer registration service.
Only trusted administrators should configure sources: private-network source
access is intentionally supported. Do not expose source creation to strangers.

## Develop And Test

### Connect A Coding Agent

Add `https://bosstunnel.com/mcp` as a remote Streamable HTTP MCP server in your
agent's MCP configuration. No BOSS account or admin token is needed. Configuration
file syntax varies by client; use that client's remote HTTP server option.

The public, stateless MCP provides `boss_docs`, `boss_search_docs` and
`boss_validate_descriptor`, seven allowlisted documentation resources, and the
`integrate_boss` prompt for app/addon development. Document reads are paginated.
Validation is offline and structural, not player certification. Never submit
private links or source credentials. The MCP cannot access private libraries,
resolve streams, create sources, modify accounts or execute code.

Browser-origin requests are restricted to the configured public origin; server
MCP clients normally omit Origin. POST bodies are capped at 32 KiB, document
chunks at 16000 characters, and requests have a 10-second deadline. Unsupported
GET/SSE and DELETE requests return 405. No persistent MCP session is stored.

### Run Tests

```sh
npm ci
npm run check
npm test
```

Tests use local synthetic fixtures, not real customer media or credentials.
They cover SDK interoperability, lazy resolution and guide discovery. They do
not certify every third-party player, codec or provider. Test your app's playback,
seeking, cancellation, pagination and capability handling on supported devices.

For a standalone addon, use `public/addon-example.mjs` and its PM2 configuration.
Set `BOSS_PUBLIC_URL`, `BOSS_MEDIA_URL` to media you own or may serve, and an
optional private `BOSS_ADDON_TOKEN`. Never publish live access links in issues.

## Release Scope

This initial publication tracks the deployed schema-10 gateway and SDK release
of 2026-09-07. Unreleased account management and additional output protocols are
not bundled or advertised as complete. Import duration and guide availability
depend on providers. Use persistent storage and verified backups for large libraries.

## Licence And Branding

MIT permits reuse, modification and distribution, including commercial use,
subject to retaining its copyright and permission notice. Dependencies retain
their own licences; see [THIRD-PARTY.md](THIRD-PARTY.md).

The official "BOSS Protocol Supported" badge is intended for BOSS integrations.
The approved artwork and brand-use policy will be published separately once the
original asset is supplied. No missing badge asset is a condition of the MIT
code licence, and displaying a badge is not evidence of player certification.

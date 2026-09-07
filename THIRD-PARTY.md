# Third-Party Licences

BossTunnel's original source code is MIT licensed. Dependencies keep their own
licences; the project licence does not replace their copyright notices or terms.
The repository does not vendor node_modules. npm installs the packages and their
licence files using package-lock.json.

Notable direct dependencies:

| Package | Licence |
| --- | --- |
| @jellyfin/sdk | MPL-2.0 |
| @streamparser/json | MIT |
| axios | MIT |
| better-sqlite3 | MIT |
| iptv-playlist-parser | MIT |
| ipaddr.js | MIT |
| lucide | ISC |
| pm2 | AGPL-3.0 |
| sax | BlueOak-1.0.0 |
| stremio-addon-sdk | MIT |
| undici | MIT |

PM2 is the separate, unmodified production process manager. The official Jellyfin
SDK is consumed as an external package. Distributors must preserve applicable
third-party notices and source obligations. Refer to each installed package's
licence for its complete terms, including transitive dependencies and development
tools. This list is not a relicensing of those projects.

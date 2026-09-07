# BOSS Developer MCP

Endpoint: `https://bosstunnel.com/mcp`

Transport: stateless Streamable HTTP using the official Model Context Protocol
Node SDK. No BOSS management credential or customer login is required.

## Tools

| Tool | Purpose |
| --- | --- |
| `boss_docs` | Read public documentation/SDK source, following `nextOffset` |
| `boss_search_docs` | Search the allowlisted protocol references |
| `boss_validate_descriptor` | Check a sanitized BOSS v1 descriptor offline |

Public resource identifiers are `boss://docs/protocol`, `boss://docs/app_guide`,
`boss://docs/addon_guide`, `boss://docs/app_sdk`, `boss://docs/addon_sdk`,
`boss://docs/addon_example` and `boss://docs/license`.

The `integrate_boss` prompt accepts `target: app` or `target: addon`.
No media-library search, account administration, private resource access, shell
execution or network fetching of submitted URLs is exposed.

## Official Client Example

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-boss-integration', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(
    new URL('https://bosstunnel.com/mcp')
  ));
  const tools = await client.listTools();
  const docs = await client.callTool({
    name: 'boss_docs',
    arguments: { document: 'protocol', offset: 0, limit: 12000 }
  });
  console.log(tools, docs);
} finally {
  await client.close();
}
```

Use client-managed initialization and protocol negotiation. Do not send ordinary
REST requests or expect a web page at `/mcp`. Use `/sdk` for human-readable docs.
Read tools' input schemas rather than guessing arguments.

## Boundaries

The MCP reads only fixed public files. It has no database reference, accepts no
arbitrary file paths, and does not fetch descriptor URLs. Do not submit real
private links, tokens or personal data. Request content is not application-logged.
The server permits 16 concurrent requests and 600 requests per minute globally;
429 responses include Retry-After. It does not offer subscriptions or legacy SSE.
Host/Origin checks reject untrusted browser origins and forwarded-host spoofing.

Build and run the normal BossTunnel gateway to self-host this MCP. Set
PUBLIC_BASE_URL to your real origin so Host validation matches your proxy.
The protocol, server implementation, examples and original docs are MIT licensed.

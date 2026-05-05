# openclaw-explorium

OpenClaw plugin for [Explorium](https://www.explorium.ai/) — B2B business and prospect data.

The plugin connects to Explorium's hosted MCP server and registers each MCP tool as a native OpenClaw tool, so the tool surface stays in sync with Explorium's API automatically.

## Status

`v0.1.0` — initial scaffold. MCP endpoint is `https://mcp.explorium.ai/mcp`, authenticated via the `api_key` request header (verified against a working LangGraph integration).

## Configuration

| Key | Required | Description |
| --- | --- | --- |
| `apiKey` | yes | Explorium API key. Plain string or SecretRef; falls back to `EXPLORIUM_API_KEY` env. |
| `mcpUrl` | no | MCP endpoint. Defaults to the hosted endpoint. |
| `authHeader` | no | Auth header name. Defaults to `api_key`. |
| `authValuePrefix` | no | Prefix prepended to the API key. Defaults to empty. |
| `debug` | no | Verbose `[explorium]` log lines. |

## Development

```bash
npm install
npm run typecheck
npm run test
```

## Webhooks

Enrollment **management** tools (`add_businesses_enrollments`, etc.) come along for free via MCP discovery. Receiving the webhook callbacks Explorium pushes is out of scope for v1 — see [`docs/webhooks.md`](docs/webhooks.md).

## License

MIT

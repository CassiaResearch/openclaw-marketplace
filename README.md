# Composio Plugin for OpenClaw

> **⚠️ This plugin is no longer actively maintained.** We're excited to announce our [Universal CLI](https://composio.dev/cli), optimized for use with OpenClaw. It outperformed this plugin on internal benchmarks, and we recommend migrating to it. This plugin will continue to work but will not receive new features or bug fixes.
>
> [Get started with the Universal CLI →](https://composio.dev/cli)

Access 1000+ third-party tools via Composio MCP — Gmail, Slack, GitHub, Notion, Linear, Jira, HubSpot, Salesforce, Google Drive, and more.

## Install

```bash
openclaw plugins install @composio/openclaw-plugin
```

Restart OpenClaw after installing.

## Setup

```bash
openclaw composio setup --key "ck_your_key_here"
```

Get your consumer key from [dashboard.composio.dev](http://dashboard.composio.dev/~/org/connect/clients/openclaw). That's it.

## How it works

Once configured, the plugin connects to Composio's MCP server at startup, fetches available tools, and registers them directly into the agent. No manual MCP config needed.

If a tool returns an auth error, the agent will prompt you to connect that app at [dashboard.composio.dev](http://dashboard.composio.dev/~/org/connect/clients/openclaw).

## AI Tools

| Tool | Description |
|---|---|
| `COMPOSIO_SEARCH_TOOLS` | Search available Composio tools by name or category |
| `COMPOSIO_GET_TOOL_SCHEMAS` | Get input schemas for specific tools |
| `COMPOSIO_MANAGE_CONNECTIONS` | Connect or disconnect third-party apps |
| `COMPOSIO_WAIT_FOR_CONNECTIONS` | Wait for OAuth flows to complete |
| `COMPOSIO_MULTI_EXECUTE_TOOL` | Execute one or more tools in a single call |

## CLI Commands

```bash
openclaw composio setup --key ck_...   # Configure consumer key
openclaw composio status               # View current configuration
openclaw composio doctor               # Test connection and list tools
```

## Configuration

Set consumer key via environment variable:

```bash
export COMPOSIO_CONSUMER_KEY="ck_..."
```

Or in `~/.openclaw/openclaw.json`:

| Option | Type | Default | Description |
|---|---|---|---|
| `consumerKey` | `string` | — | Your Composio consumer key (`ck_...`) |
| `enabled` | `boolean` | `true` | Enable or disable the plugin |
| `mcpUrl` | `string` | `https://connect.composio.dev/mcp` | MCP server URL (advanced) |

## Links

- [Composio Documentation](https://docs.composio.dev)
- [Composio Dashboard](http://dashboard.composio.dev/~/org/connect/)
- [MCP Protocol](https://modelcontextprotocol.io)

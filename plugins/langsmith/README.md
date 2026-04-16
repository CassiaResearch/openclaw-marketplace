# openclaw-langsmith

[![npm version](https://img.shields.io/npm/v/openclaw-langsmith.svg)](https://www.npmjs.com/package/openclaw-langsmith)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

LangSmith tracing plugin for [OpenClaw](https://github.com/openclaw/openclaw). Automatically traces agent turns, tool calls, and LLM invocations to [LangSmith](https://smith.langchain.com/) for observability, debugging, and cost tracking.

## Features

- **LangGraph-style traces** — Trace tree mirrors LangGraph conventions (root chain → LLM children → tool children)
- **Per-LLM-call visibility** — Each inner model invocation in the tool-use loop gets its own LLM run with exact `messages` context
- **Thread grouping** — Turns from the same session are grouped in LangSmith's Threads view via `thread_id`
- **Accurate token tracking** — Per-call token usage from assistant messages, no double-counting (root is chain, tokens on LLM children only)
- **Smart tagging** — Auto-tags traces with source (cron, discord, slack, telegram), job names, channel IDs
- **Tool nesting** — Tool calls nested under the LLM call that invoked them, not the root
- **Context-engine aware** — `historyMessages` is post-assemble, so lossless-claw / compaction output is reflected
- **Subagent tracing** — Subagent invocations appear as child chain runs
- **Batch queue** — Operations batched for efficient API usage (configurable interval and size)
- **Per-feature toggles** — Enable/disable each trace type independently
- **Zero runtime dependencies** — Uses native `fetch` and `crypto.randomUUID()`
- **Error isolation** — Tracing errors never affect gateway operation

## Quick Start

### 1. Get a LangSmith API Key

1. Sign up at [smith.langchain.com](https://smith.langchain.com/)
2. Go to **Settings > API Keys**
3. Create a new API key (starts with `lsv2_pt_...`)

### 2. Install the Plugin

```bash
cd ~/.openclaw/extensions
git clone https://github.com/joshuaswarren/openclaw-langsmith.git
cd openclaw-langsmith
npm install && npm run build
```

### 3. Add API Key to Gateway Environment

The gateway needs the API key in its environment. Choose your platform:

<details>
<summary><strong>macOS (launchd)</strong></summary>

Edit `~/Library/LaunchAgents/ai.openclaw.gateway.plist` and add inside `EnvironmentVariables`:

```xml
<key>LANGSMITH_API_KEY</key>
<string>lsv2_pt_your_key_here</string>
```
</details>

<details>
<summary><strong>Linux (systemd)</strong></summary>

Edit `~/.config/systemd/user/openclaw-gateway.service` and add to the `[Service]` section:

```ini
Environment="LANGSMITH_API_KEY=lsv2_pt_your_key_here"
```

Or create an environment file at `~/.config/openclaw/env`:

```bash
LANGSMITH_API_KEY=lsv2_pt_your_key_here
```

Then reference it in the service file:

```ini
EnvironmentFile=%h/.config/openclaw/env
```
</details>

<details>
<summary><strong>Docker</strong></summary>

Add to your `docker-compose.yml` or pass via `-e`:

```yaml
environment:
  - LANGSMITH_API_KEY=lsv2_pt_your_key_here
```
</details>

### 4. Enable in openclaw.json

```json
{
  "plugins": {
    "allow": ["openclaw-langsmith"],
    "entries": {
      "openclaw-langsmith": {
        "enabled": true,
        "config": {
          "langsmithApiKey": "${LANGSMITH_API_KEY}",
          "projectName": "openclaw"
        }
      }
    }
  }
}
```

### 5. Restart Gateway

**macOS:**
```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

**Linux:**
```bash
systemctl --user restart openclaw-gateway
```

**Docker:**
```bash
docker compose restart openclaw-gateway
```

**Verify** (all platforms):
```bash
tail -f ~/.openclaw/logs/gateway.log | grep langsmith
# Should see: [langsmith] langsmith tracing active
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `langsmithApiKey` | string | `$LANGSMITH_API_KEY` | LangSmith API key |
| `langsmithEndpoint` | string | `https://api.smith.langchain.com` | API endpoint |
| `projectName` | string | `openclaw` | LangSmith project name |
| `traceAgentTurns` | boolean | `true` | Trace agent turns |
| `traceToolCalls` | boolean | `true` | Trace tool calls |
| `batchIntervalMs` | number | `1000` | Batch flush interval (ms) |
| `batchMaxSize` | number | `20` | Max operations before flush |
| `debug` | boolean | `false` | Enable debug logging |

## Filtering Traces

Traces are automatically tagged for easy filtering in LangSmith:

| Tag | Description | Example |
|-----|-------------|---------|
| `cron` | Cron job runs | Filter all scheduled jobs |
| `discord` | Discord messages | Filter Discord conversations |
| `slack` | Slack messages | Filter Slack conversations |
| `telegram` | Telegram messages | Filter Telegram conversations |
| `job:<id>` | Specific cron job | `job:96b7720d-02b1-4373-8846-33306c9913fc` |
| `name:<name>` | Cron job name | `name:X Bookmarks → Insights pipeline` |
| `channel:<id>` | Discord channel | `channel:1467253309348909241` |
| `guild:#<name>` | Discord guild | `guild:#proj-deckard` |

## How It Works

### LangGraph-Style Trace Structure

Each user turn produces a trace tree that mirrors LangGraph conventions:

```
agent_turn (chain, root)              ← one per user message
├── anthropic/claude-… #1 (llm)       ← first LLM call (full messages as inputs)
│   ├── Read (tool)                   ← tool nested under the LLM that invoked it
│   └── Edit (tool)
├── anthropic/claude-… #2 (llm)       ← second call (sees tool results in context)
│   └── Search (tool)
├── anthropic/claude-… #3 (llm)       ← final call (produces answer)
└── subagent:research (chain)         ← if subagents were spawned
```

### Session Lifecycle
Hooks into `session_start` and `session_end`. Tracks session boundaries and cleans up state (closing any in-flight runs) when sessions end. Every LangSmith run includes `thread_id` in metadata, enabling LangSmith's Threads view to group turns from the same conversation.

### Agent Turns
Hooks into `llm_input` and `agent_end`. The root run (`agent_turn`) is a **chain** — not an LLM run — so token counts live on the children and LangSmith dashboards don't double-count. The root carries:
- Full initial context as `inputs.messages` (system + history + user prompt, post-assemble/compaction)
- Aggregated usage summary in outputs metadata
- Auto-generated tags based on session source (cron, discord, slack, etc.)

### Per-LLM-Call Tracing
Hooks into `before_message_write`. Each time an assistant message is written to the session during the tool-use loop, a new LLM child run is emitted with:
- `inputs.messages` — the exact context window the model saw on this call (grows with each tool result)
- `outputs.messages` — the assistant's response (including any tool_calls)
- Per-call token usage with cache breakdown (from the assistant message's `usage` field)
- Model and provider info

This provides real-time, per-inner-call visibility — not just a single aggregated "turn" run.

### Tool Calls
Hooks into `before_tool_call` and `after_tool_call`. Tool runs are **nested under the LLM call that invoked them** (not under the root), matching LangGraph's hierarchy.

### Subagent Runs
Hooks into `subagent_ended`. When subagents are invoked during an agent turn, they appear as child chain runs with task input and result output.

### Error Isolation
- **No API key? No problem.** If you install the plugin without configuring an API key, it simply logs a warning and disables itself — OpenClaw continues running normally
- All LangSmith API calls wrapped in try/catch
- Network failures log warnings but never affect gateway operation
- Invalid API keys or LangSmith outages won't break your agents

## Development

```bash
npm install
npm run build    # Build with tsup
npm run dev      # Watch mode
```

## Related Projects

- [OpenClaw](https://github.com/openclaw/openclaw) — The AI agent gateway
- [openclaw-engram](https://github.com/joshuawarren/openclaw-engram) — Local-first memory plugin
- [LangSmith](https://smith.langchain.com/) — LLM observability platform

## License

MIT © Joshua Warren

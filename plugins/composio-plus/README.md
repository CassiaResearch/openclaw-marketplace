# @copilotai/openclaw-composio-plus

Per-user Composio access for OpenClaw, built on the Composio TypeScript SDK
(`@composio/core`). Exposes only the **six Composio meta-tools** to the LLM
(`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`,
`COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_MANAGE_CONNECTIONS`,
`COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_REMOTE_BASH_TOOL`) — individual catalog
tools and custom tools live inside the session and are reachable through
`COMPOSIO_SEARCH_TOOLS` + `COMPOSIO_MULTI_EXECUTE_TOOL`.

> **POC**: not production-hardened. One openclaw process per Composio user;
> not multi-tenant in a single process.

## What's different from the upstream

- Built on the SDK (`composio.create(userId, { toolkits, experimental })` →
  `session.execute(...)`) instead of raw MCP `tools/list` + `tools/call`.
- Six meta-tools, not hundreds of catalog tools, registered with the agent.
- Plugin-author extensibility: custom tools, custom toolkits, custom auth
  configs, plus a connected-account flow.
- Tool registration is awaited at gateway boot — never fire-and-forget. Warm
  restart: synchronous cache fast-path. Cold start (no cache): the gateway
  awaits the cache-refresh service, which fetches the meta-tool surface and
  registers it before accepting any agent turn. No race with the first prompt.

## Setup

The default deployment target is a managed openclaw host (e.g. emma) with a
secret-provider chain configured. The manifest declares `apiKey` as a
secret-input path so openclaw resolves a credential reference at gateway
startup — no plaintext key on disk.

1. Put the Composio API key (`ak_...` from
   [app.composio.dev/developers](https://app.composio.dev/developers)) in the
   host's secret store out-of-band (e.g. `op item edit composio_api_key …`
   if you're on the 1Password provider).

2. Add a `composio-plus` entry to `~/.openclaw/openclaw.json` (hand-edited or
   laid down by config management):

   ```json
   {
     "plugins": {
       "entries": {
         "composio-plus": {
           "enabled": true,
           "config": {
             "userId": "emma",
             "apiKey": {
               "source": "exec",
               "provider": "onepassword",
               "id": "composio_api_key"
             }
           }
         }
       }
     }
   }
   ```

   The `source` / `provider` / `id` shape matches whatever the host has
   configured under `secretProviders` in `openclaw.json` (`exec` for scripts
   like `op-provider.py`, `env` for environment variables, etc.). Only
   `apiKey` resolves through the secret chain — `userId`, `baseURL`,
   `toolkits`, and `authConfigs` stay as plain values.

3. Restart the gateway:

   ```sh
   openclaw gateway restart
   ```

### Local dev shortcut

For local development where it's fine to keep the API key as plaintext in
the config file, the plugin ships a setup command that prompts for `apiKey`
and `userId` and writes both into `~/.openclaw/openclaw.json`:

```sh
openclaw composio setup
# or non-interactive:
openclaw composio setup --api-key ak_... --user-id myuser --no-prompt
```

That's all it does — no network calls, no cache priming. **Do not run this
on a managed host**: it overwrites whatever is at
`config.apiKey` with a raw string, which clobbers any secret-ref you've
configured. Restart the gateway after running it.

## How tools become available

The plugin uses a **cache-as-fast-path + service-as-source-of-truth** pattern.
You don't need to think about it day-to-day, but here's the lifecycle so
nothing surprises you:

```
Gateway boot
  ├─ register(api) [sync]
  │    ├─ if cache exists:
  │    │     register tools from cache → fast path
  │    │     log "Ready — N meta-tools registered (cache fast-path)"
  │    └─ else (first run / wiped cache):
  │           log "No cache yet — meta-tools will register via service"
  │           — no tools registered yet —
  │
  ├─ register cache-refresh service (awaited at boot)
  │
  ├─ await startPluginServices(...)
  │    └─ cache-refresh service.start runs:
  │          ├─ build/await Composio session (shared with tool dispatch)
  │          ├─ session.tools() → unwrap → fresh meta-tool defs
  │          ├─ for each meta-tool not yet registered → api.registerTool()
  │          │   (late-registration; visible to all subsequent agent turns)
  │          ├─ writeMetaToolCache(...)  ← always overwrites for next restart
  │          └─ on error: log warn, keep whatever's registered, leave old cache
  │
  └─ Gateway opens → first agent turn sees the merged set
                     (cached + late-registered)
```

Net effect:

- **First gateway start** (no cache): tools register entirely via the service. Boot waits ~2-5s for the Composio fetch.
- **Warm restarts**: tools load instantly from cache; service refreshes for next time and late-registers any new ones.
- **Composio outage during boot**: cache stays valid (last-known-good); service logs a warn but doesn't break anything.
- **Composio adds a new meta-tool**: shows up after a single restart (cached fast-path still loads the old set first, then service.start late-registers the new one before any agent turn).
- **Composio removes a meta-tool**: registered until the next gateway restart (no `api.unregisterTool` API). A warn is logged.

You only need to re-run `composio setup` when your credentials change.

## Configuration

Full config schema in `openclaw.plugin.json`. Example:

```json
{
  "apiKey": "ak_xxx",
  "userId": "user-1",
  "authConfigs": {
    "hubspot": "ac_your_hubspot_config",
    "github":  "ac_your_github_config"
  }
}
```

**`toolkits` is optional.** Per Composio's docs, omitting it gives the session **full Composio catalog access** — agent discovers tools at runtime via `COMPOSIO_SEARCH_TOOLS` without needing a curated list. Only set `toolkits: [...]` when you want to *restrict* scope (e.g., `["hubspot", "gmail"]` to keep the agent within those toolkits only).

**`authConfigs` is a flat `{ toolkit: ac_... }` map.** Pre-existing auth config ids only — auth configs themselves are created in the Composio dashboard. The map is passed straight through to `composio.create(userId, { authConfigs })` so `COMPOSIO_MANAGE_CONNECTIONS` uses your branded OAuth app instead of Composio's managed default.

### Custom tools — grouped by toolkit, statically imported

Custom tools live under `src/custom-tools/` in this plugin's source, organized
by toolkit:

```
src/custom-tools/
├── index.ts              # aggregator — imports each toolkit's array
├── instantly/
│   ├── index.ts          # exports instantlyTools
│   └── reply.ts          # REPLY_TO_EMAIL definition
└── ...
```

Each tool is a standalone TypeScript file:

```ts
// src/custom-tools/instantly/reply.ts
import { experimental_createTool } from "@composio/core";
// zod 3.25+ ships v3 and v4 under subpaths; the default export is v4.
// experimental_createTool's instanceof check requires v3 — always import
// from "zod/v3" for custom tool schemas.
import { z } from "zod/v3";

export const replyTool = experimental_createTool("REPLY_TO_EMAIL", {
  name: "Reply to email (Instantly)",
  description: "...",
  extendsToolkit: "instantly",  // inherits Instantly's managed auth
  inputParams: z.object({...}),
  // Use `function` (not an arrow). The SDK's proxyExecute relies on `this`
  // internally — call it with `.call(ctx, ...)` to keep the binding intact.
  execute: async function (input, ctx) {
    return (ctx as any).proxyExecute.call(ctx, {...});
  },
});
```

The toolkit's `index.ts` aggregates its tools:

```ts
// src/custom-tools/instantly/index.ts
import { replyTool } from "./reply.js";
export const instantlyTools = [replyTool];
```

The top-level `src/custom-tools/index.ts` ties everything together:

```ts
import { instantlyTools } from "./instantly/index.js";
export const customTools = [...instantlyTools];
export const customToolkits: never[] = [];  // populated only for tools that don't extendsToolkit
```

Use `customToolkits` only for tools that author a brand-new logical toolkit
(via `experimental_createToolkit`). Tools that use `extendsToolkit:
"<existing-toolkit>"` go in `customTools` only.

After adding/editing a custom tool, restart the gateway. No config edit
needed — custom tools live in plugin source and are bound to the session
each time `register()` runs. The meta-tool cache is independent.

## CLI commands

| Command | Purpose |
|---|---|
| `composio setup [--api-key ak_...] [--user-id ...] [--no-prompt] [--force]` | Local-dev only: write a plain-string `apiKey` and `userId` into plugin config. Refuses to overwrite an existing secret reference unless `--force` is given. Does NOT touch the cache or fetch tools. |
| `composio status` | Print config, cache state, and auth-config bindings. Renders `apiKey` as `<secret ref: ...>` on managed deploys without resolving it. Read-only. |

Connected-account flow is driven by the agent through the
`COMPOSIO_MANAGE_CONNECTIONS` meta-tool — there is no CLI surface for it.

## State files

- `~/.openclaw/openclaw.json` — plugin config under
  `plugins.entries.composio-plus.config`.
- `~/.openclaw/state/composio-plus/meta-tools-{hash}.json` — cached meta-tool
  defs (six entries). Hash keys by `baseURL`.

## Architecture (short)

```
register(api) [sync]
  ├─ parse config; if missing apiKey/userId → log warn + return
  ├─ register CLI subcommands
  ├─ kick off sessionPromise (warmup; reused by tool dispatch + cache-refresh service)
  ├─ readMetaToolCache(baseURL):
  │    ├─ cache hit  → register N tools sync (fast path); tracks registeredNames
  │    └─ cache miss → no tools registered yet; service.start handles it
  └─ register cache-refresh service:
       service.start (awaited at gateway boot, BEFORE first agent turn):
         ├─ await sessionPromise (reuse warmed session)
         ├─ session.tools() → unwrap → fresh meta-tool defs
         ├─ diff against registeredNames → late-register new ones
         ├─ writeMetaToolCache(...) for next restart
         └─ log warn for tools removed upstream (still registered until restart)
```

Setup is credentials-only — no cache priming, no network. The cache-refresh
service handles all tool registration. On first run with no cache, tools
register entirely via the service (boot waits for the Composio fetch). On
warm restarts, the cache fast-path means instant tool availability while the
service refreshes for next time. Composio outages during boot don't break
the gateway — the cache stays valid.

## Files

```
composio-plus-plugin/
├── package.json
├── openclaw.plugin.json     # manifest + configSchema + uiHints
├── index.ts                 # plugin entry: sync register + cache-refresh service
└── src/
    ├── config.ts            # Zod schema, parseComposioPlusConfig
    ├── types.ts             # ComposioPlusConfig + CachedMetaTool
    ├── session.ts           # buildSessionFromConfig (composio.create + customTools binding)
    ├── refresh.ts           # fetchMetaToolsFromSession — used by the cache-refresh service
    ├── dispatch.ts          # routeMultiExecute — splits MULTI_EXECUTE_TOOL local/remote
    ├── metaToolCache.ts     # sync read/write of cached meta-tool defs
    ├── cli.ts               # api.registerCli subcommands (setup, status)
    └── custom-tools/
        ├── index.ts         # aggregator — exports customTools, customToolkits
        └── instantly/
            ├── index.ts     # toolkit-specific aggregator
            └── reply.ts     # REPLY_TO_EMAIL definition
```

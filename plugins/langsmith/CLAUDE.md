# openclaw-langsmith

## PUBLIC REPOSITORY — Privacy Policy

**This repository is PUBLIC on GitHub.** Every commit is visible to the world.

### Rules for ALL agents committing to this repo:

1. **NEVER commit API keys, tokens, or secrets** — even in comments or examples
2. **NEVER commit trace data** — LangSmith traces contain conversation content
3. **NEVER commit session IDs or user identifiers** — these are private
4. **NEVER commit `.env` files** or any file containing credentials
5. **NEVER reference specific users, conversations, or sessions** in code comments or commit messages
6. **Config examples must use placeholders** — `${LANGSMITH_API_KEY}`, not actual keys

### What IS safe to commit:
- Source code (`src/`)
- Package manifests (`package.json`, `tsconfig.json`, `tsup.config.ts`)
- Plugin manifest (`openclaw.plugin.json`)
- Documentation (`README.md`, `docs/`)
- Build configuration
- `.gitignore`
- This `CLAUDE.md` file

### Before every commit, verify:
- `git diff --cached` contains NO personal information
- No hardcoded API keys, URLs with tokens, or credentials
- No references to specific users or their trace data

## Architecture Notes

### File Structure
```
src/
├── index.ts              # Plugin entry point, hook registration
├── config.ts             # Config parsing
├── types.ts              # TypeScript interfaces
├── logger.ts             # Logging wrapper
├── client.ts             # LangSmith API client
└── tracer.ts             # Trace management and batching
```

### Key Patterns

1. **LangGraph-style trace tree** — root `chain` → N `llm` children (one per inner LLM call) → `tool` children nested under the LLM that invoked them
2. **Session-scoped state** — one `TurnState` per active session, keyed by `sessionKey`, no singletons
3. **Thread grouping** — every LangSmith run includes `thread_id: sessionKey` in metadata
4. **Per-call messages** — each LLM child run's `inputs.messages` is the exact context window the model saw on that call
5. **Per-call token usage** — extracted from each assistant message's `usage` field, no double-counting (root is `chain` type, tokens only on `llm` children)
6. **Real-time tracing via `before_message_write`** — assistant messages fire as they're written to the session, giving per-inner-call visibility inside the tool-use loop
7. **Graceful shutdown** — flush pending traces on stop

### Integration Points

- `api.on("session_start")` — session lifecycle tracking
- `api.on("session_end")` — cleanup session state, close any in-flight runs
- `api.on("llm_input")` — start turn: create root chain, seed message buffer from post-assemble session state
- `api.on("before_message_write")` — per-message: emit LLM child run on assistant messages, grow message buffer on all messages
- `api.on("agent_end")` — end turn: close root chain with aggregated metadata
- `api.on("subagent_ended")` — track subagent runs as child chains
- `api.on("before_tool_call")` — start tool run (parented under invoking LLM call)
- `api.on("after_tool_call")` — end tool run
- `api.registerService()` — graceful shutdown

### Testing Locally

```bash
# Build
npm run build

# Reload gateway
kill -USR1 $(pgrep openclaw-gateway)

# Trigger an agent run, then check LangSmith dashboard

# View logs
grep "\[langsmith\]" ~/.openclaw/logs/gateway.log
```

### Common Gotchas

1. **Missing API key** — add to launchd plist EnvironmentVariables
2. **Token data missing** — model/provider may not include usage in assistant message
3. **Model shows undefined** — check all detection sources in order
4. **No inner-call visibility** — verify `before_message_write` hook is registered (check boot log for "registering before_message_write hook")
5. **Compaction retry** — if llm_input fires twice (compaction retry), the first root closes as "Compacted and retried" and a fresh trace starts

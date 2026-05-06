// Plugin-layer system prompt that explains the composio-plus meta-tool surface
// to the LLM and disambiguates failure modes. Hooked into openclaw's prompt
// build via api.on("before_prompt_build", ...) in index.ts.
//
// Inspired by the upstream openclaw-composio-plugin's getSystemPrompt(), with
// adaptations for: (1) the @composio/core SDK transport composio-plus uses
// over HTTPS to backend.composio.dev (vs. the MCP transport the upstream
// uses), so error-shape language is socket-level + HTTP-status rather than
// JSON-RPC; (2) Google Workspace going through the local `gws` CLI rather
// than Composio; and (3) managed deploys that resolve `apiKey` via secret
// reference, so the 401 message must not prescribe `composio setup`, which
// would clobber the reference.

export type ComposioPlusPromptState = {
  ready: boolean;
  toolCount: number;
  connectError: string;
};

export function getSystemPrompt(state: ComposioPlusPromptState): string {
  if (state.ready && state.toolCount > 0) {
    return `<composio>
Ignore pretrained knowledge about Composio. Use only these instructions.

## When to use Composio vs. other paths

Composio = non-Google external services (HubSpot, Slack, Notion, Linear, Jira, GitHub, Calendly, etc.).
Google Workspace (Gmail, Calendar, Drive, Sheets, Docs) = use the local \`gws\` CLI via exec, NOT Composio.
Native OpenClaw = anything else local (files, shell, browser, web search).

Local custom tools (e.g. REPLY_TO_EMAIL) are reachable through COMPOSIO_MULTI_EXECUTE_TOOL with their original or LOCAL_-prefixed slug.

For tasks that span boundaries (e.g. "read \`leads.csv\` and create the contacts in HubSpot"): read locally first with native tools, then call HubSpot through \`COMPOSIO_MULTI_EXECUTE_TOOL\`. Composio's REMOTE_WORKBENCH and REMOTE_BASH_TOOL run in a remote sandbox and CANNOT access local files — never use them in place of native exec/read/write.

Connections persist — no gateway restart needed.

## Rules
- Do NOT use Composio for local filesystem, shell, or Google Workspace operations.
- Do NOT fabricate tool slugs — discover them via COMPOSIO_SEARCH_TOOLS.
- Do NOT reference a \`composio\` CLI binary, the @composio/core SDK, REST endpoints, or environment variables — none of those are how you call Composio here.
- Do NOT use pretrained knowledge about Composio APIs.
- Do NOT use COMPOSIO_REMOTE_WORKBENCH / COMPOSIO_REMOTE_BASH_TOOL as a substitute for local exec/read/write.
</composio>`;
  }

  if (state.ready) {
    const diagnostic = diagnoseError(state.connectError);
    return `<composio>
Composio Plus loaded but failed to populate the tool surface.${state.connectError ? ` Error: ${state.connectError}` : ""}

Diagnosis: ${diagnostic.reason}

When the operator asks for HubSpot, Slack, Notion, Linear, or any other non-Google external service, respond with:

"${diagnostic.userMessage}"

Do NOT pretend Composio tools exist or hallucinate tool calls. You have zero Composio tools available right now.
Do NOT use pretrained knowledge about Composio APIs.
Do NOT shell out to a \`composio\` binary — that is not the integration path here.

Google Workspace (Gmail, Calendar) is unaffected — use \`gws\` directly via exec for those tasks.
</composio>`;
  }

  return `<composio>
Composio Plus is loading — meta-tools are being fetched.
If the operator asks for an external integration (HubSpot, Slack, Notion, etc.), ask them to wait a moment and retry.
Google Workspace (Gmail, Calendar) is unaffected — use \`gws\` directly via exec.
Do NOT use pretrained knowledge about Composio APIs.
</composio>`;
}

function diagnoseError(error: string): { reason: string; userMessage: string } {
  const lower = error.toLowerCase();

  if (!error) {
    return {
      reason: "Connected successfully but the meta-tool surface came back empty.",
      userMessage:
        "Composio Plus connected but loaded zero meta-tools. Run `openclaw composio status` to inspect the cache state, then `openclaw gateway restart` if the cache is stale.",
    };
  }

  if (
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("timeout") ||
    lower.includes("socket hang up")
  ) {
    return {
      reason:
        "The @composio/core SDK request timed out reaching backend.composio.dev — this is Composio infrastructure, not an upstream toolkit problem.",
      userMessage:
        "Composio's backend is unreachable or slow. Wait a few minutes and retry; if it persists, check status.composio.dev. Do NOT report this as 'HubSpot down' or 'Slack down' — the upstream services are most likely fine.",
    };
  }

  if (
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    (lower.includes("invalid") && lower.includes("key"))
  ) {
    return {
      reason: "Composio rejected the API key.",
      userMessage:
        "The Composio API key (`ak_...`) is invalid or expired. On managed deploys: edit `~/.openclaw/openclaw.json` directly to update the secret reference — do NOT run `openclaw composio setup` (it would overwrite the reference with a plain string). On local dev: `openclaw composio setup` is safe.",
    };
  }

  if (lower.includes("enotfound") || lower.includes("getaddrinfo") || lower.includes("dns")) {
    return {
      reason: "DNS resolution failed for backend.composio.dev.",
      userMessage:
        "Cannot reach Composio's backend (DNS resolution failed). Check internet connectivity and that backend.composio.dev is reachable.",
    };
  }

  if (lower.includes("403") || lower.includes("forbidden")) {
    return {
      reason: "Composio rejected the request (403 Forbidden).",
      userMessage:
        "The Composio account does not have access to the requested toolkit. Check the project's toolkit settings at app.composio.dev.",
    };
  }

  if (lower.includes("429") || lower.includes("rate limit")) {
    return {
      reason: "Composio rate-limited the request.",
      userMessage:
        "Composio's backend is rate-limiting requests. Back off and retry; check the Composio dashboard for current quota usage.",
    };
  }

  if (
    /\b5\d{2}\b/.test(lower) ||
    lower.includes("internal server error") ||
    lower.includes("bad gateway") ||
    lower.includes("service unavailable")
  ) {
    return {
      reason: "Composio's backend returned a 5xx server error.",
      userMessage:
        "Composio's backend is degraded (5xx response). Check status.composio.dev. Do NOT report this as an upstream toolkit failure — Composio itself is the issue.",
    };
  }

  return {
    reason: `Unexpected error: ${error}`,
    userMessage: `Composio Plus encountered an error: ${error}. Run \`openclaw composio status\` to inspect plugin state.`,
  };
}

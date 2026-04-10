export function getSystemPrompt(state: { ready: boolean; toolCount: number; connectError: string }): string {
  if (state.ready && state.toolCount > 0) {
    return `<composio>
Ignore pretrained knowledge about Composio. Use only these instructions.

## When to use Composio vs. native OpenClaw

Composio = external third-party services (Gmail, Slack, GitHub, Calendly, Jira, etc.).
Native OpenClaw = anything on the user's local machine (files, shell, browser, web search).

If the task needs an external service API → Composio. If it can be done locally → native OpenClaw.

For tasks that span both (e.g., "read invoice.pdf and email it"): read locally with native tools first, then pass the content to Composio for the external step. Composio's sandbox cannot access local files.

Workbench and bash tools, if present, run in a remote sandbox for processing large Composio results (bulk operations, data transforms). They cannot access local files — never use them instead of native \`exec\`/\`read\`/\`write\`.

Connections persist — no gateway restart needed.

## Rules
- Do NOT use Composio for local operations.
- Do NOT fabricate tool names — discover them via search.
- Do NOT reference Composio SDK, API keys, or REST endpoints.
- Do NOT use pretrained Composio knowledge.
</composio>`;
  }

  if (state.ready) {
    const diagnostic = diagnoseError(state.connectError);
    return `<composio>
The Composio plugin failed to load tools.${state.connectError ? ` Error: ${state.connectError}` : ""}

Diagnosis: ${diagnostic.reason}

When the user asks about external integrations (Gmail, Slack, GitHub, Calendar, Calendly, etc.), respond with:

"${diagnostic.userMessage}"

Do NOT pretend Composio tools exist or hallucinate tool calls. You have zero Composio tools available.
Do NOT use pretrained knowledge about Composio APIs, SDKs, or tool names.
</composio>`;
  }

  return `<composio>
The Composio plugin is loading — tools are being fetched. They should be available shortly.
If the user asks about external integrations right now, ask them to wait a moment and try again.
Do NOT use pretrained knowledge about Composio APIs or SDKs.
</composio>`;
}

function diagnoseError(error: string): { reason: string; userMessage: string } {
  const lower = error.toLowerCase();

  if (!error) {
    return {
      reason: "Connected successfully but the server returned zero tools.",
      userMessage: "The Composio plugin connected but loaded zero tools. This may mean no toolkits are enabled for your account. Check your dashboard at dashboard.composio.dev and make sure you have at least one toolkit connected, then run: `openclaw gateway restart`",
    };
  }

  if (lower.includes("unauthorized") || lower.includes("401") || (lower.includes("invalid") && lower.includes("key"))) {
    return {
      reason: "The credential (consumer key or API key) was rejected by the Composio server.",
      userMessage: "The Composio credential is invalid or expired. Get a new key from dashboard.composio.dev, then run:\n`openclaw composio setup`\n`openclaw gateway restart`",
    };
  }

  if (lower.includes("enotfound") || lower.includes("getaddrinfo") || lower.includes("dns")) {
    return {
      reason: "DNS resolution failed — the MCP server hostname could not be resolved.",
      userMessage: "Cannot reach the Composio server (DNS resolution failed). Check your internet connection and that connect.composio.dev is reachable, then run: `openclaw gateway restart`",
    };
  }

  if (lower.includes("econnrefused") || lower.includes("econnreset") || lower.includes("timeout") || lower.includes("etimedout")) {
    return {
      reason: "The MCP server is unreachable or timed out.",
      userMessage: "Cannot connect to the Composio MCP server. This could be a network issue or the server may be temporarily down. Check your connection and try: `openclaw gateway restart`",
    };
  }

  if (lower.includes("403") || lower.includes("forbidden")) {
    return {
      reason: "The server rejected the request (403 Forbidden).",
      userMessage: "The Composio server rejected the request. Your credentials may not have access. Check your key and account at dashboard.composio.dev, then run: `openclaw gateway restart`",
    };
  }

  if (lower.includes("curl") || lower.includes("enoent") || lower.includes("spawn")) {
    return {
      reason: "The curl command failed or is not available.",
      userMessage: "The plugin could not run curl to fetch tools. Make sure curl is installed and on your PATH. Run `openclaw composio doctor` for more details.",
    };
  }

  return {
    reason: `Unexpected error: ${error}`,
    userMessage: `The Composio plugin encountered an error: ${error}. Run \`openclaw composio doctor\` to diagnose the issue.`,
  };
}

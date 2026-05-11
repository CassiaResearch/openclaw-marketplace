// Plugin-layer system prompt for the composio-plus meta-tool surface, hooked
// into openclaw's prompt build via api.on("before_prompt_build", ...) in
// index.ts.

import type { SessionToolkitInfo } from "./types.js";

export type ComposioPlusPromptState = {
  ready: boolean;
  toolCount: number;
  connectError: string;
  /** Undefined until the first session-toolkits refresh lands. */
  sessionToolkits?: SessionToolkitInfo[];
  /**
   * Session bind mode. `"allow"` = narrow allowlist (literal enumeration of
   * not-yet-connected toolkits is small and useful). `"disable"` and
   * `"open"` both mean ~the whole catalog is reachable, so bucket B renders
   * as a one-liner instead of enumerating ~1000 items.
   */
  mode: "allow" | "disable" | "open";
};

export function getSystemPrompt(state: ComposioPlusPromptState): string {
  if (state.ready && state.toolCount > 0) {
    return `<composio>
Ignore pretrained knowledge about Composio. Use only these instructions.

## When to use Composio vs. other paths

${renderComposioRoutingLine(state)}
Google Workspace (Gmail, Calendar, Drive, Sheets, Docs) = use the local \`gws\` CLI via exec, NOT Composio.
Native OpenClaw = anything else local (files, shell, browser, web search).

Local custom tools (e.g. REPLY_TO_EMAIL) are reachable through COMPOSIO_MULTI_EXECUTE_TOOL with their original or LOCAL_-prefixed slug.

For tasks that span boundaries (e.g. "read \`leads.csv\` and create the contacts in HubSpot"): read locally first with native tools, then call HubSpot through \`COMPOSIO_MULTI_EXECUTE_TOOL\`. Composio's REMOTE_WORKBENCH and REMOTE_BASH_TOOL run in a remote sandbox and CANNOT access local files — never use them in place of native exec/read/write.

Connections persist — no gateway restart needed.

${renderTailSections(state)}
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

/**
 * Inline connected toolkits as concrete examples for the routing rule.
 * Falls back to a hardcoded breadth list when nothing's connected, so the
 * rule keeps anchor examples while the cache is empty.
 */
function renderComposioRoutingLine(state: ComposioPlusPromptState): string {
  const connected = state.sessionToolkits?.filter((t) => t.isActive) ?? [];
  if (connected.length === 0) {
    return "Composio = non-Google external services (HubSpot, Slack, Notion, Linear, Jira, GitHub, Calendly, etc.).";
  }
  const lines = connected.map((t) => `- ${t.name} (\`${t.slug}\`)`).join("\n");
  return `Composio (non-Google external services) — currently wired up for:
${lines}

Route directly to these — connectivity is established. Use COMPOSIO_SEARCH_TOOLS only to discover the specific tool slug, not to confirm coverage.`;
}

/**
 * "Configured but not yet connected" and "Other apps" sections. The
 * connected bucket is inlined by renderComposioRoutingLine instead. Returns
 * "" when the cache hasn't filled (routing line uses hardcoded fallback).
 *
 * Disable-mode collapses bucket B to a one-liner: enumerating ~1000
 * not-yet-connected toolkits would blow the prompt past 25kB, and the
 * operator doesn't get value from a literal catalog dump (the agent already
 * knows Composio supports most apps).
 */
function renderTailSections(state: ComposioPlusPromptState): string {
  if (!state.sessionToolkits || state.sessionToolkits.length === 0) {
    return "";
  }

  const sections: string[] = [];

  if (state.mode === "disable" || state.mode === "open") {
    sections.push("## Other catalog toolkits");
    sections.push(
      "Any toolkit in Composio's catalog (https://docs.composio.dev/toolkits.md) that isn't connected yet can be wired up with COMPOSIO_MANAGE_CONNECTIONS — surface the returned redirect_url to the operator as a markdown link and wait for confirmation before invoking any of the toolkit's tools. If you're unsure whether a specific app is in the catalog, use COMPOSIO_SEARCH_TOOLS to check.",
    );
    sections.push("");
    return sections.join("\n");
  }

  const notConnected = state.sessionToolkits.filter((t) => !t.isActive);

  sections.push("## Configured but not yet connected — call MANAGE_CONNECTIONS first");
  if (notConnected.length > 0) {
    sections.push(
      "These toolkits are in your session's allowlist but have no active connection. When the operator names one, call COMPOSIO_MANAGE_CONNECTIONS with the toolkit slug, surface the returned redirect_url to the operator as a markdown link, and wait for them to confirm connection before invoking any of its tools.",
      "",
      notConnected.map((t) => `- ${t.name} (\`${t.slug}\`)`).join("\n"),
    );
  } else {
    sections.push("(none — every callable toolkit is connected.)");
  }
  sections.push("");

  sections.push("## Other apps");
  sections.push(
    "For apps not in either list, check https://docs.composio.dev/toolkits.md — Composio's full catalog. If the app appears there, tell the operator the toolkit must be added to your session's `config.toolkits` or `authConfigs` and the gateway restarted. If it's not in the catalog, tell the operator there's no Composio integration for it.",
  );
  sections.push("");

  return sections.join("\n");
}

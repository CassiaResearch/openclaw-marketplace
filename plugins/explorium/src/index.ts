import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "openclaw-explorium";

// Skill-only carrier. Tools are surfaced via OpenClaw's bundle-mcp runtime
// from `mcp.servers.explorium` in the host config — this plugin just ships
// the workflow guidance in skills/explorium/SKILL.md.
const plugin: OpenClawPluginDefinition = {
  id: PLUGIN_ID,
  name: "Explorium",
  description:
    "Workflow skill for the Explorium MCP server (tools provided by bundle-mcp via mcp.servers.explorium).",

  register(): void {},
};

export default plugin;

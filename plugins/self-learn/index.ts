import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSkillManageTool } from "./src/tool.js";
import { buildSelfLearnGuidance } from "./src/guidance-prompt.js";
import { ensureHeartbeatTask } from "./src/heartbeat.js";
import { resolveSkillsDir } from "./src/paths.js";

let heartbeatInitialized = false;

export default definePluginEntry({
  id: "self-learn",
  name: "Self-Learn Plugin",
  description: "Autonomous skill creation and evolution from agent experience",
  register(api) {
    const pluginConfig = api.pluginConfig;
    const maxSkills = typeof pluginConfig?.maxSkills === "number" ? pluginConfig.maxSkills : 100;

    // Tool registration — factory receives workspaceDir at invocation time.
    api.registerTool(
      (ctx) => createSkillManageTool(ctx.workspaceDir ?? ".", maxSkills),
      { name: "skill_manage" },
    );

    api.on("before_prompt_build", async (_event, ctx) => {
      const workspaceDir = ctx.workspaceDir ?? ".";

      // One-time: add heartbeat task if enabled.
      if (!heartbeatInitialized) {
        heartbeatInitialized = true;
        if (pluginConfig?.enableHeartbeat !== false) {
          try { ensureHeartbeatTask(workspaceDir); } catch { /* non-fatal */ }
        }
      }

      return {
        appendSystemContext: buildSelfLearnGuidance(resolveSkillsDir(workspaceDir)),
      };
    });
  },
});

import fs from "node:fs";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSkillManageTool } from "./src/tool.js";
import { buildSelfLearnGuidance } from "./src/guidance-prompt.js";
import { resolveSkillsDir } from "./src/paths.js";
import {
  LEGACY_HEARTBEAT_MARKER,
  reconcileSelfLearnCron,
  type CronService,
} from "./src/cron.js";

const STARTUP_RETRY_MS = 750;

type GatewayCtxWithCron = {
  port?: number;
  getCron?: () => CronService | undefined;
};

export default definePluginEntry({
  id: "self-learn",
  name: "Self-Learn Plugin",
  description: "Autonomous skill creation and evolution from agent experience",
  register(api) {
    api.logger.warn("self-learn: plugin register");
    const pluginConfig = api.pluginConfig as
      | Record<string, unknown>
      | undefined;
    const maxSkills =
      typeof pluginConfig?.maxSkills === "number"
        ? pluginConfig.maxSkills
        : 100;

    let retryTimer: NodeJS.Timeout | undefined;
    let inFlight = false;
    let legacyMarkerChecked = false;

    const readConfig = () => {
      const cfg = pluginConfig ?? {};
      return {
        enabled: cfg.enableCron !== false,
        expr:
          typeof cfg.cron === "string" && cfg.cron.length > 0
            ? cfg.cron
            : "0 */6 * * *",
        tz:
          typeof cfg.timezone === "string" && cfg.timezone.length > 0
            ? cfg.timezone
            : undefined,
        slackChannel:
          typeof cfg.slackChannel === "string" && cfg.slackChannel.length > 0
            ? cfg.slackChannel
            : undefined,
      };
    };

    const reconcileOnce = async (cron: CronService | null) => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await reconcileSelfLearnCron({
          cron,
          config: readConfig(),
          logger: api.logger,
        });
        api.logger.info(`self-learn cron reconcile: ${result.status}`);
      } catch (err) {
        api.logger.error(`self-learn cron reconcile failed: ${String(err)}`);
      } finally {
        inFlight = false;
      }
    };

    api.registerTool(
      (ctx) => createSkillManageTool(ctx.workspaceDir ?? ".", maxSkills),
      { name: "skill_manage" },
    );

    api.on("before_prompt_build", async (_event, ctx) => {
      const workspaceDir = ctx.workspaceDir ?? ".";

      if (!legacyMarkerChecked) {
        legacyMarkerChecked = true;
        try {
          const content = fs.readFileSync(
            path.join(workspaceDir, "HEARTBEAT.md"),
            "utf-8",
          );
          if (content.includes(LEGACY_HEARTBEAT_MARKER)) {
            api.logger.warn(
              "self-learn: detected legacy 'self-learn-review' block in HEARTBEAT.md. " +
                "The plugin no longer manages it (replaced by a gateway cron). " +
                "Remove the block manually to avoid duplicate review runs.",
            );
          }
        } catch {
          // No HEARTBEAT.md or unreadable — nothing to warn about.
        }
      }

      return {
        appendSystemContext: buildSelfLearnGuidance(
          resolveSkillsDir(workspaceDir),
        ),
      };
    });

    api.on("gateway_start", async (_event, ctx) => {
      api.logger.warn("self-learn: gateway start");
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      const cron = (ctx as GatewayCtxWithCron).getCron?.() ?? null;
      if (!cron) {
        api.logger.warn(
          `self-learn: cron service not yet available; retrying in ${STARTUP_RETRY_MS}ms`,
        );
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          const retryCron = (ctx as GatewayCtxWithCron).getCron?.() ?? null;
          void reconcileOnce(retryCron);
        }, STARTUP_RETRY_MS);
        return;
      }
      api.logger.info("self-learn: cron service available; reconciling");
      await reconcileOnce(cron);
    });

    api.on("gateway_stop", () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      inFlight = false;
    });
  },
});

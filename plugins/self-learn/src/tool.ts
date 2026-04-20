import { ensureSkillsDir } from "./paths.js";
import { executeList } from "./actions/list.js";
import { executeView } from "./actions/view.js";
import { executeCreate } from "./actions/create.js";
import { executeEdit } from "./actions/edit.js";
import { executePatch } from "./actions/patch.js";
import { executeDelete } from "./actions/delete.js";
import { executeWriteFile } from "./actions/write-file.js";
import { executeRemoveFile } from "./actions/remove-file.js";

/**
 * Plain JSON Schema for the skill_manage tool parameters.
 * Uses raw JSON Schema objects instead of @sinclair/typebox so the plugin
 * works outside the OpenClaw monorepo without transitive dependency issues.
 * Pattern from tlon/index.ts which also uses plain JSON Schema.
 */
const SkillManageSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "view", "create", "edit", "patch", "delete", "write_file", "remove_file"],
      description:
        "Action to perform. list: show all self-learned skills. view: read a skill's content. " +
        "create: make a new skill. edit: full SKILL.md rewrite. patch: targeted find-and-replace. " +
        "delete: remove a skill. write_file: add a supporting file. remove_file: delete a supporting file.",
    },
    name: {
      type: "string",
      description: "Skill name in kebab-case (required for all actions except list).",
    },
    content: {
      type: "string",
      description:
        "Full SKILL.md content including frontmatter (for create/edit) or file content (for write_file).",
    },
    category: {
      type: "string",
      description: "Category subdirectory for organization (for create).",
    },
    find: {
      type: "string",
      description: "Exact text to find in SKILL.md (required for patch).",
    },
    replace: {
      type: "string",
      description: "Replacement text (required for patch).",
    },
    file_path: {
      type: "string",
      description:
        "Relative path within skill directory (for view, write_file, remove_file). " +
        "Must be under references/, scripts/, assets/, or templates/.",
    },
  },
  required: ["action"],
} as const;

type SkillManageParams = {
  action: string;
  name?: string;
  content?: string;
  category?: string;
  find?: string;
  replace?: string;
  file_path?: string;
};

/**
 * Format a tool result in the AgentToolResult shape expected by OpenClaw.
 * Pattern from feishu/src/tool-result.ts and tlon/index.ts.
 */
function jsonToolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * Create the skill_manage tool.
 * Takes workspaceDir — skills are stored in {workspaceDir}/skills/self-learned-*
 */
export function createSkillManageTool(workspaceDir: string, maxSkills: number) {
  return {
    name: "skill_manage",
    label: "Skill Manager",
    description:
      "Create, view, update, and delete self-learned skills. Skills capture reusable procedural " +
      "knowledge from complex tasks. Use after completing complex tasks (5+ tool calls), fixing " +
      "tricky errors, or discovering non-trivial workflows.",
    parameters: SkillManageSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const params = rawParams as SkillManageParams;
      ensureSkillsDir(workspaceDir);

      switch (params.action) {
        case "list":
          return jsonToolResult(executeList(workspaceDir));

        case "view": {
          if (!params.name) return jsonToolResult({ success: false, error: "Parameter 'name' is required for view." });
          return jsonToolResult(executeView(workspaceDir, params.name, params.file_path));
        }

        case "create": {
          if (!params.name) return jsonToolResult({ success: false, error: "Parameter 'name' is required for create." });
          if (!params.content) return jsonToolResult({ success: false, error: "Parameter 'content' is required for create." });
          return jsonToolResult(executeCreate(workspaceDir, params.name, params.content, maxSkills));
        }

        case "edit": {
          if (!params.name) return jsonToolResult({ success: false, error: "Parameter 'name' is required for edit." });
          if (!params.content) return jsonToolResult({ success: false, error: "Parameter 'content' is required for edit." });
          return jsonToolResult(executeEdit(workspaceDir, params.name, params.content));
        }

        case "patch": {
          if (!params.name) return jsonToolResult({ success: false, error: "Parameter 'name' is required for patch." });
          if (!params.find) return jsonToolResult({ success: false, error: "Parameter 'find' is required for patch." });
          if (params.replace === undefined) return jsonToolResult({ success: false, error: "Parameter 'replace' is required for patch." });
          return jsonToolResult(executePatch(workspaceDir, params.name, params.find, params.replace));
        }

        case "delete": {
          if (!params.name) return jsonToolResult({ success: false, error: "Parameter 'name' is required for delete." });
          return jsonToolResult(executeDelete(workspaceDir, params.name));
        }

        case "write_file": {
          if (!params.name) return jsonToolResult({ success: false, error: "Parameter 'name' is required for write_file." });
          if (!params.file_path) return jsonToolResult({ success: false, error: "Parameter 'file_path' is required for write_file." });
          if (!params.content) return jsonToolResult({ success: false, error: "Parameter 'content' is required for write_file." });
          return jsonToolResult(executeWriteFile(workspaceDir, params.name, params.file_path, params.content));
        }

        case "remove_file": {
          if (!params.name) return jsonToolResult({ success: false, error: "Parameter 'name' is required for remove_file." });
          if (!params.file_path) return jsonToolResult({ success: false, error: "Parameter 'file_path' is required for remove_file." });
          return jsonToolResult(executeRemoveFile(workspaceDir, params.name, params.file_path));
        }

        default:
          return jsonToolResult({ success: false, error: `Unknown action: '${params.action}'.` });
      }
    },
  };
}

import fs from "node:fs";
import path from "node:path";
import { validateName, validateFilePath } from "../validation.js";
import { skillExists } from "../discovery.js";
import { resolveSkillDir } from "../paths.js";

export type RemoveFileResult =
  | { success: true; name: string; filePath: string }
  | { success: false; error: string };

export function executeRemoveFile(
  workspaceDir: string,
  name: string,
  filePath: string,
): RemoveFileResult {
  const nameCheck = validateName(name);
  if (!nameCheck.valid) return { success: false, error: nameCheck.error! };

  if (!skillExists(workspaceDir, name)) {
    return { success: false, error: `Skill '${name}' does not exist.` };
  }

  const pathCheck = validateFilePath(name, filePath, workspaceDir);
  if (!pathCheck.valid) return { success: false, error: pathCheck.error! };

  const skillDir = resolveSkillDir(workspaceDir, name);
  const fullPath = path.resolve(skillDir, filePath);

  if (!fs.existsSync(fullPath)) {
    return { success: false, error: `File '${filePath}' does not exist in skill '${name}'.` };
  }

  try {
    fs.unlinkSync(fullPath);

    let parentDir = path.dirname(fullPath);
    while (parentDir !== skillDir && parentDir.startsWith(skillDir)) {
      const entries = fs.readdirSync(parentDir);
      if (entries.length === 0) {
        fs.rmdirSync(parentDir);
        parentDir = path.dirname(parentDir);
      } else {
        break;
      }
    }
  } catch (err) {
    return { success: false, error: `Failed to remove file: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { success: true, name, filePath };
}

import { validateName } from "../validation.js";
import { skillExists } from "../discovery.js";
import { removeSkillDirSync } from "../atomic-write.js";
import { resolveSkillDir } from "../paths.js";

export type DeleteResult =
  | { success: true; name: string }
  | { success: false; error: string };

export function executeDelete(workspaceDir: string, name: string): DeleteResult {
  const nameCheck = validateName(name);
  if (!nameCheck.valid) return { success: false, error: nameCheck.error! };

  if (!skillExists(workspaceDir, name)) {
    return { success: false, error: `Skill '${name}' does not exist.` };
  }

  const skillDir = resolveSkillDir(workspaceDir, name);

  try {
    removeSkillDirSync(skillDir);
  } catch (err) {
    return { success: false, error: `Failed to delete skill: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { success: true, name };
}

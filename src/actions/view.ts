import { readSkillContent, readSkillFile, listSkillFiles, skillExists } from "../discovery.js";
import { validateName } from "../validation.js";

export type ViewResult =
  | { success: true; content: string; files?: string[] }
  | { success: false; error: string };

export function executeView(
  workspaceDir: string,
  name: string,
  filePath?: string,
): ViewResult {
  const nameCheck = validateName(name);
  if (!nameCheck.valid) return { success: false, error: nameCheck.error! };

  if (!skillExists(workspaceDir, name)) {
    return { success: false, error: `Skill '${name}' does not exist.` };
  }

  if (filePath) {
    const content = readSkillFile(workspaceDir, name, filePath);
    if (content === null) {
      return { success: false, error: `File '${filePath}' not found in skill '${name}'.` };
    }
    return { success: true, content };
  }

  const content = readSkillContent(workspaceDir, name);
  if (content === null) {
    return { success: false, error: `Could not read SKILL.md for '${name}'.` };
  }

  const files = listSkillFiles(workspaceDir, name);
  return { success: true, content, files };
}

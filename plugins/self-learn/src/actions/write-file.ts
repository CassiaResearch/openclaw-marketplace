import path from "node:path";
import { validateName, validateFilePath } from "../validation.js";
import { skillExists } from "../discovery.js";
import { scanSkillContent, isWriteAllowed, formatScanError } from "../security-guard.js";
import { atomicWriteFileSync } from "../atomic-write.js";
import { resolveSkillDir } from "../paths.js";

export type WriteFileResult =
  | { success: true; name: string; filePath: string; warnings: string[] }
  | { success: false; error: string };

export function executeWriteFile(
  workspaceDir: string,
  name: string,
  filePath: string,
  content: string,
): WriteFileResult {
  const nameCheck = validateName(name);
  if (!nameCheck.valid) return { success: false, error: nameCheck.error! };

  if (!skillExists(workspaceDir, name)) {
    return { success: false, error: `Skill '${name}' does not exist. Create the skill first.` };
  }

  const pathCheck = validateFilePath(name, filePath, workspaceDir);
  if (!pathCheck.valid) return { success: false, error: pathCheck.error! };

  const scan = scanSkillContent(content);
  if (!isWriteAllowed(scan)) {
    return { success: false, error: formatScanError(scan) };
  }

  const fullPath = path.resolve(resolveSkillDir(workspaceDir, name), filePath);

  try {
    atomicWriteFileSync(fullPath, content);
  } catch (err) {
    return { success: false, error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}` };
  }

  const warnings = [...pathCheck.warnings];
  if (scan.threats.length > 0) {
    warnings.push(`Security scan: ${scan.threats.join("; ")} (allowed at caution level)`);
  }

  return { success: true, name, filePath, warnings };
}

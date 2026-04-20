import { validateCreate } from "../validation.js";
import { scanSkillContent, isWriteAllowed, formatScanError } from "../security-guard.js";
import { atomicWriteFileSync, removeSkillDirSync } from "../atomic-write.js";
import { resolveSkillFilePath, resolveSkillDir, ensureSkillsDir } from "../paths.js";
import { parseFrontmatter } from "../discovery.js";

export type CreateResult =
  | { success: true; name: string; path: string; warnings: string[] }
  | { success: false; error: string };

function ensureAuthorField(content: string): string {
  const fm = parseFrontmatter(content);
  if (fm.author) return content;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return content;
  return content.slice(0, firstNewline + 1) + "author: self-learn-plugin\n" + content.slice(firstNewline + 1);
}

export function executeCreate(
  workspaceDir: string,
  name: string,
  content: string,
  maxSkills: number,
): CreateResult {
  ensureSkillsDir(workspaceDir);

  const validation = validateCreate(name, content, workspaceDir, maxSkills);
  if (!validation.valid) return { success: false, error: validation.error! };

  const scan = scanSkillContent(content);
  if (!isWriteAllowed(scan)) {
    return { success: false, error: formatScanError(scan) };
  }

  const skillDir = resolveSkillDir(workspaceDir, name);
  const skillFilePath = resolveSkillFilePath(workspaceDir, name);
  const finalContent = ensureAuthorField(content);

  try {
    atomicWriteFileSync(skillFilePath, finalContent);
  } catch (err) {
    try { removeSkillDirSync(skillDir); } catch { /* ignore */ }
    return { success: false, error: `Failed to write skill: ${err instanceof Error ? err.message : String(err)}` };
  }

  const warnings = [...validation.warnings];
  if (scan.threats.length > 0) {
    warnings.push(`Security scan: ${scan.threats.join("; ")} (allowed at caution level)`);
  }

  return { success: true, name, path: skillFilePath, warnings };
}

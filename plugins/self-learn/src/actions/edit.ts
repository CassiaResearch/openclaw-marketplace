import { validateEdit } from "../validation.js";
import { scanSkillContent, isWriteAllowed, formatScanError } from "../security-guard.js";
import { atomicWriteFileSync } from "../atomic-write.js";
import { resolveSkillFilePath } from "../paths.js";
import { readSkillContent, parseFrontmatter } from "../discovery.js";

export type EditResult =
  | { success: true; name: string; warnings: string[] }
  | { success: false; error: string };

function ensureAuthorField(content: string): string {
  const fm = parseFrontmatter(content);
  if (fm.author) return content;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return content;
  return content.slice(0, firstNewline + 1) + "author: self-learn-plugin\n" + content.slice(firstNewline + 1);
}

export function executeEdit(
  workspaceDir: string,
  name: string,
  content: string,
): EditResult {
  const validation = validateEdit(name, content, workspaceDir);
  if (!validation.valid) return { success: false, error: validation.error! };

  const scan = scanSkillContent(content);
  if (!isWriteAllowed(scan)) {
    return { success: false, error: formatScanError(scan) };
  }

  const skillFilePath = resolveSkillFilePath(workspaceDir, name);
  const original = readSkillContent(workspaceDir, name);
  const finalContent = ensureAuthorField(content);

  try {
    atomicWriteFileSync(skillFilePath, finalContent);
  } catch (err) {
    if (original !== null) {
      try { atomicWriteFileSync(skillFilePath, original); } catch { /* ignore */ }
    }
    return { success: false, error: `Failed to write skill: ${err instanceof Error ? err.message : String(err)}` };
  }

  const warnings = [...validation.warnings];
  if (scan.threats.length > 0) {
    warnings.push(`Security scan: ${scan.threats.join("; ")} (allowed at caution level)`);
  }

  return { success: true, name, warnings };
}

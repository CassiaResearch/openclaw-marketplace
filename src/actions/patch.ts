import { validatePatch, validateFrontmatter } from "../validation.js";
import { scanSkillContent, isWriteAllowed, formatScanError } from "../security-guard.js";
import { atomicWriteFileSync } from "../atomic-write.js";
import { resolveSkillFilePath } from "../paths.js";
import { readSkillContent } from "../discovery.js";

export type PatchResult =
  | { success: true; name: string; replacements: number; warnings: string[] }
  | { success: false; error: string };

export function executePatch(
  workspaceDir: string,
  name: string,
  find: string,
  replace: string,
): PatchResult {
  const validation = validatePatch(name, find, workspaceDir);
  if (!validation.valid) return { success: false, error: validation.error! };

  const original = readSkillContent(workspaceDir, name);
  if (original === null) {
    return { success: false, error: `Could not read SKILL.md for '${name}'.` };
  }

  if (!original.includes(find)) {
    return { success: false, error: `Could not find the specified text in '${name}/SKILL.md'. Verify the exact text to replace.` };
  }

  let count = 0;
  let patched = original;
  while (patched.includes(find)) {
    patched = patched.replace(find, replace);
    count++;
  }

  const fmCheck = validateFrontmatter(patched);
  if (!fmCheck.valid) {
    return { success: false, error: `Patch would produce invalid SKILL.md: ${fmCheck.error}` };
  }

  const scan = scanSkillContent(patched);
  if (!isWriteAllowed(scan)) {
    return { success: false, error: formatScanError(scan) };
  }

  const skillFilePath = resolveSkillFilePath(workspaceDir, name);

  try {
    atomicWriteFileSync(skillFilePath, patched);
  } catch (err) {
    try { atomicWriteFileSync(skillFilePath, original); } catch { /* ignore */ }
    return { success: false, error: `Failed to write patch: ${err instanceof Error ? err.message : String(err)}` };
  }

  const warnings = [...validation.warnings, ...fmCheck.warnings];
  if (scan.threats.length > 0) {
    warnings.push(`Security scan: ${scan.threats.join("; ")} (allowed at caution level)`);
  }

  return { success: true, name, replacements: count, warnings };
}

import fs from "node:fs";
import path from "node:path";

const SKILL_PREFIX = "self-learned-";

/**
 * Resolve the workspace skills directory.
 * Skills go into {workspaceDir}/skills/ — the standard OpenClaw workspace
 * skills location, already in the skill loading pipeline.
 */
export function resolveSkillsDir(workspaceDir: string): string {
  return path.join(workspaceDir, "skills");
}

/**
 * Build the prefixed directory name for a self-learned skill.
 * e.g., "deep-research" → "self-learned-deep-research"
 */
export function prefixedName(name: string): string {
  if (name.startsWith(SKILL_PREFIX)) return name;
  return `${SKILL_PREFIX}${name}`;
}

/**
 * Strip the prefix to get the logical skill name.
 * e.g., "self-learned-deep-research" → "deep-research"
 */
export function unprefixedName(name: string): string {
  if (name.startsWith(SKILL_PREFIX)) return name.slice(SKILL_PREFIX.length);
  return name;
}

/**
 * Check whether a directory name is a self-learned skill.
 */
export function isSelfLearnedSkill(dirName: string): boolean {
  return dirName.startsWith(SKILL_PREFIX);
}

export function resolveSkillDir(workspaceDir: string, name: string): string {
  return path.join(resolveSkillsDir(workspaceDir), prefixedName(name));
}

export function resolveSkillFilePath(workspaceDir: string, name: string): string {
  return path.join(resolveSkillsDir(workspaceDir), prefixedName(name), "SKILL.md");
}

export function ensureSkillsDir(workspaceDir: string): void {
  fs.mkdirSync(resolveSkillsDir(workspaceDir), { recursive: true });
}

export function isPathInsideSkillsDir(targetPath: string, workspaceDir: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(resolveSkillsDir(workspaceDir));
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

export { SKILL_PREFIX };

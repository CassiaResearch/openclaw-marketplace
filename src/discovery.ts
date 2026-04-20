import fs from "node:fs";
import path from "node:path";
import {
  resolveSkillsDir,
  isSelfLearnedSkill,
  prefixedName,
  unprefixedName,
} from "./paths.js";

export type SkillMeta = {
  name: string;
  description: string;
  filePath: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Returns key-value pairs from the --- delimited block.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!content.startsWith("---")) return result;

  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return result;

  const block = content.slice(4, endIdx);
  for (const line of block.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * List self-learned skills from the workspace skills directory.
 * Only scans directories with the `self-learned-` prefix.
 */
export function listSkills(workspaceDir: string): SkillMeta[] {
  const skillsDir = resolveSkillsDir(workspaceDir);
  if (!fs.existsSync(skillsDir)) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills: SkillMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !isSelfLearnedSkill(entry.name)) continue;

    const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const content = fs.readFileSync(skillMdPath, "utf-8");
      const fm = parseFrontmatter(content);
      const stat = fs.statSync(skillMdPath);

      skills.push({
        name: fm.name || unprefixedName(entry.name),
        description: fm.description || "",
        filePath: skillMdPath,
        author: fm.author || undefined,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Skip unreadable skills.
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Check whether a self-learned skill with the given name exists.
 */
export function skillExists(workspaceDir: string, name: string): boolean {
  const skillsDir = resolveSkillsDir(workspaceDir);
  return fs.existsSync(path.join(skillsDir, prefixedName(name), "SKILL.md"));
}

/**
 * Read the full SKILL.md content for a self-learned skill.
 */
export function readSkillContent(workspaceDir: string, name: string): string | null {
  const skillsDir = resolveSkillsDir(workspaceDir);
  const skillMdPath = path.join(skillsDir, prefixedName(name), "SKILL.md");
  try {
    return fs.readFileSync(skillMdPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read a supporting file from a self-learned skill directory.
 */
export function readSkillFile(workspaceDir: string, name: string, filePath: string): string | null {
  const skillsDir = resolveSkillsDir(workspaceDir);
  const fullPath = path.join(skillsDir, prefixedName(name), filePath);
  try {
    return fs.readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * List files in a self-learned skill directory.
 */
export function listSkillFiles(workspaceDir: string, name: string): string[] {
  const skillsDir = resolveSkillsDir(workspaceDir);
  const skillDir = path.join(skillsDir, prefixedName(name));
  if (!fs.existsSync(skillDir)) return [];

  const files: string[] = [];
  function walk(dir: string, prefix: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        files.push(rel);
      }
    }
  }
  walk(skillDir, "");
  return files;
}

export { parseFrontmatter };

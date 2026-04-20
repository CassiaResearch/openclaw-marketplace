import path from "node:path";
import { parseFrontmatter, skillExists, listSkills } from "./discovery.js";
import { isPathInsideSkillsDir, resolveSkillDir } from "./paths.js";

export type ValidationResult = {
  valid: boolean;
  error?: string;
  warnings: string[];
};

// agentskills.io spec: lowercase alphanumeric + hyphens, no consecutive hyphens,
// no leading/trailing hyphens, max 64 chars.
const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;
const RECOMMENDED_MAX_LINES = 500;
const ALLOWED_SUPPORTING_DIRS = new Set(["references", "scripts", "assets", "templates"]);

// agentskills.io spec: only these top-level frontmatter fields are defined.
// Unknown fields like "triggers", "tags", "keywords" are rejected to keep
// skills spec-compliant. Additional metadata goes under the `metadata` field.
const ALLOWED_FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  // Standard but not in spec — widely used and accepted by OpenClaw:
  "author",
  "user-invocable",
  "disable-model-invocation",
]);

export function validateName(name: string): ValidationResult {
  const warnings: string[] = [];

  if (!name) {
    return { valid: false, error: "Skill name is required.", warnings };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { valid: false, error: `Skill name must be at most ${MAX_NAME_LENGTH} characters (got ${name.length}).`, warnings };
  }
  if (name.includes("--")) {
    return { valid: false, error: "Skill name must not contain consecutive hyphens (--).", warnings };
  }
  if (!NAME_RE.test(name)) {
    return { valid: false, error: "Skill name must be lowercase alphanumeric with hyphens, starting with a letter (e.g., 'deploy-k8s-helm').", warnings };
  }

  return { valid: true, warnings };
}

export function validateFrontmatter(content: string): ValidationResult {
  const warnings: string[] = [];

  if (!content.startsWith("---")) {
    return { valid: false, error: "SKILL.md must start with YAML frontmatter (---).", warnings };
  }

  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { valid: false, error: "SKILL.md frontmatter must have a closing --- line.", warnings };
  }

  const fm = parseFrontmatter(content);

  if (!fm.name) {
    return { valid: false, error: "Frontmatter must include a 'name' field.", warnings };
  }
  if (!fm.description) {
    return { valid: false, error: "Frontmatter must include a 'description' field.", warnings };
  }
  if (fm.description.length > MAX_DESCRIPTION_LENGTH) {
    return { valid: false, error: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters (got ${fm.description.length}).`, warnings };
  }
  if (fm.compatibility && fm.compatibility.length > MAX_COMPATIBILITY_LENGTH) {
    return { valid: false, error: `Compatibility must be at most ${MAX_COMPATIBILITY_LENGTH} characters (got ${fm.compatibility.length}).`, warnings };
  }

  // Reject unknown frontmatter fields (agentskills.io spec compliance).
  // Trigger keywords, tags, etc. belong in the description field, not as
  // separate frontmatter fields.
  const unknownFields = Object.keys(fm).filter((key) => !ALLOWED_FRONTMATTER_FIELDS.has(key));
  if (unknownFields.length > 0) {
    return {
      valid: false,
      error:
        `Unknown frontmatter field(s): ${unknownFields.join(", ")}. ` +
        `The agentskills.io spec only allows: ${[...ALLOWED_FRONTMATTER_FIELDS].join(", ")}. ` +
        `Trigger keywords belong in the description field. ` +
        `Custom metadata goes under the 'metadata' key (e.g., metadata:\\n  version: "1.0").`,
      warnings,
    };
  }

  // Body after frontmatter
  const body = content.slice(endIdx + 4).trim();
  if (!body) {
    warnings.push("SKILL.md has no body content after frontmatter. Consider adding instructions.");
  }

  const lineCount = content.split("\n").length;
  if (lineCount > RECOMMENDED_MAX_LINES) {
    warnings.push(
      `SKILL.md is ${lineCount} lines (recommended < ${RECOMMENDED_MAX_LINES}). ` +
      `Consider splitting detailed content into reference files for progressive disclosure.`,
    );
  }

  return { valid: true, warnings };
}

export function validateCreate(
  name: string,
  content: string,
  workspaceDir: string,
  maxSkills: number,
): ValidationResult {
  const warnings: string[] = [];

  const nameResult = validateName(name);
  if (!nameResult.valid) return nameResult;
  warnings.push(...nameResult.warnings);

  const fmResult = validateFrontmatter(content);
  if (!fmResult.valid) return fmResult;
  warnings.push(...fmResult.warnings);

  // Check frontmatter name matches directory name
  const fm = parseFrontmatter(content);
  if (fm.name && fm.name !== name) {
    return { valid: false, error: `Frontmatter name '${fm.name}' must match the skill name '${name}'.`, warnings };
  }

  if (skillExists(workspaceDir, name)) {
    return { valid: false, error: `A skill named '${name}' already exists. Use action='edit' to rewrite or action='patch' to update.`, warnings };
  }

  const currentSkills = listSkills(workspaceDir);
  if (currentSkills.length >= maxSkills) {
    return { valid: false, error: `Maximum skill limit (${maxSkills}) reached. Delete unused skills before creating new ones.`, warnings };
  }

  return { valid: true, warnings };
}

export function validateEdit(
  name: string,
  content: string,
  workspaceDir: string,
): ValidationResult {
  const warnings: string[] = [];

  const nameResult = validateName(name);
  if (!nameResult.valid) return nameResult;
  warnings.push(...nameResult.warnings);

  if (!skillExists(workspaceDir, name)) {
    return { valid: false, error: `Skill '${name}' does not exist. Use action='create' to create it first.`, warnings };
  }

  const fmResult = validateFrontmatter(content);
  if (!fmResult.valid) return fmResult;
  warnings.push(...fmResult.warnings);

  const fm = parseFrontmatter(content);
  if (fm.name && fm.name !== name) {
    return { valid: false, error: `Frontmatter name '${fm.name}' must match the skill name '${name}'.`, warnings };
  }

  return { valid: true, warnings };
}

export function validatePatch(
  name: string,
  find: string,
  workspaceDir: string,
): ValidationResult {
  const warnings: string[] = [];

  const nameResult = validateName(name);
  if (!nameResult.valid) return nameResult;
  warnings.push(...nameResult.warnings);

  if (!skillExists(workspaceDir, name)) {
    return { valid: false, error: `Skill '${name}' does not exist.`, warnings };
  }

  if (!find) {
    return { valid: false, error: "The 'find' parameter is required for patch action.", warnings };
  }

  return { valid: true, warnings };
}

export function validateFilePath(
  name: string,
  filePath: string,
  workspaceDir: string,
): ValidationResult {
  const warnings: string[] = [];

  if (!filePath) {
    return { valid: false, error: "The 'file_path' parameter is required.", warnings };
  }

  if (filePath.includes("..") || path.isAbsolute(filePath)) {
    return { valid: false, error: "File path must be relative and must not contain '..' segments.", warnings };
  }

  // Check the first segment is an allowed subdirectory (or SKILL.md itself)
  const firstSegment = filePath.split("/")[0];
  if (firstSegment === "SKILL.md") {
    return { valid: false, error: "Use action='edit' or action='patch' to modify SKILL.md directly.", warnings };
  }
  if (!ALLOWED_SUPPORTING_DIRS.has(firstSegment)) {
    warnings.push(
      `File path starts with '${firstSegment}/'. Standard subdirectories are: ${[...ALLOWED_SUPPORTING_DIRS].join(", ")}.`,
    );
  }

  const fullPath = path.resolve(resolveSkillDir(workspaceDir, name), filePath);
  if (!isPathInsideSkillsDir(fullPath, resolveSkillDir(workspaceDir, name))) {
    return { valid: false, error: "File path resolves outside the skill directory.", warnings };
  }

  return { valid: true, warnings };
}

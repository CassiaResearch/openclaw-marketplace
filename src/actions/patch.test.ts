import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executePatch } from "./patch.js";
import { resolveSkillFilePath } from "../paths.js";

const SKILL_NAME = "test-skill";

const BASE_CONTENT = `---
name: test-skill
description: A skill used in unit tests for the patch action.
---

# Test Skill

Some intro text.

## Tools Used

- tool A
- tool B
`;

function setupSkill(content: string = BASE_CONTENT): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-learn-test-"));
  const skillFile = resolveSkillFilePath(workspaceDir, SKILL_NAME);
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, content);
  return workspaceDir;
}

describe("executePatch", () => {
  let workspaceDir: string;

  afterEach(() => {
    if (workspaceDir) fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("terminates when replace contains find as a substring (regression test for infinite loop)", () => {
    workspaceDir = setupSkill();
    const find = "## Tools Used";
    const replace = "## New Section\n\nSome notes here.\n\n## Tools Used";

    const result = executePatch(workspaceDir, SKILL_NAME, find, replace);

    expect(result.success).toBe(true);
    if (result.success) expect(result.replacements).toBe(1);

    const written = fs.readFileSync(resolveSkillFilePath(workspaceDir, SKILL_NAME), "utf-8");
    expect(written).toContain("## New Section");
    expect(written).toContain("## Tools Used");
    expect(written.match(/## Tools Used/g)?.length).toBe(1);
    expect(written.match(/## New Section/g)?.length).toBe(1);
  });

  it("replaces every occurrence and reports the correct count", () => {
    const content = BASE_CONTENT + "\n## Tools Used\n\n- tool C\n";
    workspaceDir = setupSkill(content);

    const result = executePatch(workspaceDir, SKILL_NAME, "## Tools Used", "## Resources");

    expect(result.success).toBe(true);
    if (result.success) expect(result.replacements).toBe(2);

    const written = fs.readFileSync(resolveSkillFilePath(workspaceDir, SKILL_NAME), "utf-8");
    expect(written).not.toContain("## Tools Used");
    expect(written.match(/## Resources/g)?.length).toBe(2);
  });

  it("returns an error when find is not present", () => {
    workspaceDir = setupSkill();
    const result = executePatch(workspaceDir, SKILL_NAME, "## Nonexistent Heading", "anything");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Could not find/);

    const written = fs.readFileSync(resolveSkillFilePath(workspaceDir, SKILL_NAME), "utf-8");
    expect(written).toBe(BASE_CONTENT);
  });

  it("returns an error when the skill does not exist", () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-learn-test-"));
    const result = executePatch(workspaceDir, "missing-skill", "anything", "anything");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/does not exist/);
  });

  it("rejects patches that break frontmatter and leaves the file untouched", () => {
    workspaceDir = setupSkill();
    const result = executePatch(workspaceDir, SKILL_NAME, "name: test-skill", "");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/invalid SKILL\.md/);

    const written = fs.readFileSync(resolveSkillFilePath(workspaceDir, SKILL_NAME), "utf-8");
    expect(written).toBe(BASE_CONTENT);
  });
});

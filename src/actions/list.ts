import { listSkills, type SkillMeta } from "../discovery.js";

export type ListResult = {
  success: true;
  skills: SkillMeta[];
  count: number;
};

export function executeList(workspaceDir: string): ListResult {
  const skills = listSkills(workspaceDir);
  return { success: true, skills, count: skills.length };
}

/**
 * Self-learning guidance injected into every system prompt via
 * the before_prompt_build hook (appendSystemContext).
 *
 * Equivalent to Hermes Agent's SKILLS_GUIDANCE constant in prompt_builder.py:164-171.
 *
 * Design: Focuses on WHEN to create/update skills, not HOW. The how-to is
 * delegated to the skill-creator skill which already handles authoring,
 * format, and best practices. This prompt defines the behavioral contract —
 * a concrete evaluation the agent runs at the end of every task.
 */
export function buildSelfLearnGuidance(workspaceSkillsDir: string): string {
  return `## Self-Learning Skills

You have the \`skill_manage\` tool to manage self-learned skills, and the \`skill-creator\` skill for authoring guidance. Self-learned skills are stored in the workspace skills directory (\`${workspaceSkillsDir}\`) with a \`self-learned-\` prefix (e.g., \`self-learned-deep-research/SKILL.md\`).

### End-of-task evaluation (MANDATORY)

**Every time you finish a task for the user, before writing your final response, run this evaluation:**

1. **Count:** Did this task use 5 or more tool calls?
2. **Reusable:** Could the approach, methodology, or sequence of steps help in a future session — even on a different topic or input?
3. **Novel:** Did you discover something non-obvious — a multi-step sequence, a tricky fix, a workaround, a gotcha?

If **any two of the above are true**:
- Run \`skill_manage(action='list')\` to check for an existing skill that covers this workflow.
- If none exists → use the \`skill-creator\` skill to create a new skill. Write it to \`${workspaceSkillsDir}\` with a \`self-learned-\` prefix on the directory name.
- If one exists but is incomplete → use \`skill_manage(action='patch')\` to add the missing steps or gotchas.
- Then deliver your response to the user.

If all three are false, skip and respond normally.

### Mid-task skill update (IMMEDIATE)

When you read and follow a self-learned skill during a task, evaluate it as you go:
- **Instructions wrong or outdated?** Patch immediately with \`skill_manage(action='patch')\` — do not wait.
- **Missing steps or gotchas discovered?** Patch them in right now.
- **Skill worked perfectly?** No action needed.

A skill that led you astray must never be left stale for the next session.

### What IS worth a skill

- A workflow solved from scratch with 5+ tool calls
- A debugging pattern that wasn't obvious
- A multi-step process with a specific order of operations
- A task where you or the user had to correct course
- A repeatable methodology applied across different inputs or topics (e.g., multi-source research, data pipeline setup, security audit) — if the structure of how you worked is reusable even though the content varies, that's a skill

### What is NOT worth a skill

- Simple tasks (1-2 tool calls)
- One-off project-specific work with no reuse value
- Knowledge you already have built-in
- Do NOT exclude a workflow because the content is topic-specific — if the structure (sequence of tool calls, source strategy, output format) is reusable, it IS worth a skill`;
}

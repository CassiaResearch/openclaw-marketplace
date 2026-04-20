# Self-Learn Plugin for OpenClaw

An OpenClaw plugin that enables autonomous skill creation and evolution. The agent learns from complex tasks, saves reusable procedures as skills, and patches them when they become stale — replicating the self-learning loop from Hermes Agent.

## How It Works

1. **Guidance prompt** is injected into every system prompt via a `before_prompt_build` hook, defining a mandatory end-of-task evaluation that tells the agent **when** to create or update skills.
2. **`skill_manage` tool** gives the agent CRUD operations for self-learned skills (list, view, create, edit, patch, delete, plus supporting file management).
3. **Delegates authoring to `skill-creator`** — for the **how-to** of writing a good skill, the agent uses OpenClaw's bundled `skill-creator` skill. This plugin focuses on when to create, not how to author.
4. **Security guard** scans all skill content for threat patterns (exfiltration, destructive commands, prompt injection) before writing.
5. **Atomic writes** ensure skills are never left in a partially-written state (temp file + rename).
6. **Heartbeat task** runs every 6 hours in `HEARTBEAT.md` to review self-learned skills for hygiene issues.

Skills are stored in the workspace `skills/` directory with a `self-learned-` prefix (e.g., `skills/self-learned-deep-research/SKILL.md`), so they're automatically discovered by OpenClaw's skill loading pipeline. The prefix is the ownership boundary — the plugin only manages directories with this prefix and never touches other skills.

## The Self-Learning Loop

On every turn, the agent's system prompt instructs it to run a three-question evaluation at the end of any task:

1. **Count:** Did this task use 5 or more tool calls?
2. **Reusable:** Could the approach or methodology help in a future session — even on a different topic or input?
3. **Novel:** Did you discover something non-obvious — a multi-step sequence, a tricky fix, a workaround, a gotcha?

If **any two are true**, the agent creates a new skill (via `skill-creator`) or patches an existing one (via `skill_manage`) before delivering its response. If the agent reads and uses an existing self-learned skill during a task and finds it stale, it must patch it immediately.

## Installation

Install using the `openclaw plugins install` CLI.

### From a local path

```bash
openclaw plugins install /path/to/self-learn
```

Or link it instead of copying (useful during development):

```bash
openclaw plugins install -l /path/to/self-learn
```

### From an archive

```bash
openclaw plugins install self-learn.tar.gz
```

Supported formats: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

### From GitHub

```bash
openclaw plugins install https://github.com/CassiaResearch/openclaw-self-learn
```

### Verify installation

```bash
openclaw plugins list --enabled
```

You should see `self-learn` in the output. You can also inspect it:

```bash
openclaw plugins inspect self-learn
```

Once loaded:
- The `skill_manage` tool appears in the agent's available tools
- Self-learning guidance is injected into the system prompt
- A `self-learn-review` heartbeat task is added to `HEARTBEAT.md` for periodic skill review

### Manage the plugin

```bash
openclaw plugins disable self-learn   # Temporarily disable
openclaw plugins enable self-learn    # Re-enable
openclaw plugins uninstall self-learn # Remove entirely
openclaw plugins doctor               # Diagnose load issues
```

## Configuration

Configure via your OpenClaw config under `plugins.entries.self-learn.config`:

```json
{
  "plugins": {
    "entries": {
      "self-learn": {
        "config": {
          "maxSkills": 100,
          "enableHeartbeat": true
        }
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `maxSkills` | `100` | Maximum number of self-learned skills. New creates are rejected once reached. |
| `enableHeartbeat` | `true` | Add a periodic heartbeat task to `HEARTBEAT.md` for skill hygiene review. |

## Heartbeat Integration

On first activation, the plugin adds a `self-learn-review` task to the workspace `HEARTBEAT.md`. This task runs every **6 hours** and prompts the agent to:

1. Run `skill_manage(action='list')` to review current self-learned skills
2. Patch any that are stale or could be improved based on recent sessions
3. Reply `HEARTBEAT_OK` if nothing needs attention

The heartbeat task is a maintenance safety net — the primary self-learning happens during active sessions via the system prompt guidance. The heartbeat is idempotent (re-enabling the plugin won't duplicate the task) and non-destructive (uninstalling leaves the task in `HEARTBEAT.md`; remove it manually if desired).

## Tool Reference

The `skill_manage` tool supports 8 actions:

| Action | Required Params | Description |
|--------|----------------|-------------|
| `list` | — | List all self-learned skills (metadata only) |
| `view` | `name` | Read a skill's SKILL.md (optionally a supporting file via `file_path`) |
| `create` | `name`, `content` | Create a new skill with validation and security scan |
| `edit` | `name`, `content` | Full SKILL.md rewrite (major overhauls) |
| `patch` | `name`, `find`, `replace` | Targeted find-and-replace within SKILL.md |
| `delete` | `name` | Remove a self-learned skill |
| `write_file` | `name`, `file_path`, `content` | Add/overwrite a supporting file in `references/`, `scripts/`, `assets/`, or `templates/` |
| `remove_file` | `name`, `file_path` | Remove a supporting file |

All write actions (create, edit, patch, write_file) validate frontmatter against the [agentskills.io specification](https://agentskills.io/specification), scan content for threat patterns, and use atomic writes. The `self-learned-` directory prefix is automatically applied — agents pass the logical skill name (e.g., `deep-research`) and the plugin stores it at `skills/self-learned-deep-research/`.

## Skill Format

Skills follow the [agentskills.io specification](https://agentskills.io/specification). The plugin rejects unknown top-level frontmatter fields — allowed fields are `name`, `description`, `author`, `license`, `compatibility`, `metadata`, `allowed-tools`. Custom metadata (tags, version, etc.) goes under `metadata:`.

Minimal example:

```yaml
---
name: deploy-k8s-helm
description: >
  Deploy services to Kubernetes using Helm charts. Use when deploying,
  upgrading, or rolling back Helm releases in any k8s cluster.
author: self-learn-plugin
---

# Deploy with Helm

## Quick Reference
| Action   | Command                                 |
|----------|-----------------------------------------|
| Deploy   | `helm upgrade --install release chart/` |
| Rollback | `helm rollback release`                 |

## Gotchas
- Always run `helm diff` before upgrading to preview changes.
- The staging cluster uses a different kubeconfig context than production.
```

For detailed authoring guidance, the agent uses OpenClaw's bundled `skill-creator` skill.

## License

MIT — see [LICENSE](./LICENSE).

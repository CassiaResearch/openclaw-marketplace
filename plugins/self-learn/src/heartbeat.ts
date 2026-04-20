import fs from "node:fs";
import path from "node:path";

const HEARTBEAT_TASK_MARKER = "# self-learn-plugin heartbeat task";

const HEARTBEAT_TASK_BLOCK = `
${HEARTBEAT_TASK_MARKER}
tasks:
  - name: self-learn-review
    interval: 6h
    prompt: >
      Self-learning skill review: Run skill_manage(action='list') to see current
      self-learned skills. Check if any are stale or could be improved based on
      recent sessions. If nothing needs attention, reply HEARTBEAT_OK.
`;

/**
 * Ensure the self-learning heartbeat task exists in HEARTBEAT.md.
 * Called during plugin activation to inject the periodic skill review.
 *
 * If HEARTBEAT.md doesn't exist, creates it.
 * If it exists but doesn't have our task, appends it.
 * If it already has our task, does nothing.
 */
export function ensureHeartbeatTask(workspaceDir: string): void {
  const heartbeatPath = path.join(workspaceDir, "HEARTBEAT.md");

  let content = "";
  try {
    content = fs.readFileSync(heartbeatPath, "utf-8");
  } catch {
    // File doesn't exist — we'll create it.
  }

  if (content.includes(HEARTBEAT_TASK_MARKER)) {
    return; // Already present.
  }

  const updated = content.trimEnd() + "\n" + HEARTBEAT_TASK_BLOCK;
  fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
  fs.writeFileSync(heartbeatPath, updated, "utf-8");
}

/**
 * Remove the self-learning heartbeat task from HEARTBEAT.md.
 * Called if the plugin is disabled.
 */
export function removeHeartbeatTask(workspaceDir: string): void {
  const heartbeatPath = path.join(workspaceDir, "HEARTBEAT.md");

  let content = "";
  try {
    content = fs.readFileSync(heartbeatPath, "utf-8");
  } catch {
    return; // Nothing to remove.
  }

  if (!content.includes(HEARTBEAT_TASK_MARKER)) {
    return;
  }

  // Remove the block from the marker to the end of the tasks block.
  const markerIdx = content.indexOf(HEARTBEAT_TASK_MARKER);
  const before = content.slice(0, markerIdx).trimEnd();

  // Find the end of our task block — look for next non-indented, non-empty line
  // after the tasks: section, or end of file.
  const afterMarker = content.slice(markerIdx);
  const lines = afterMarker.split("\n");
  let endOffset = afterMarker.length;
  let inTasks = false;
  let pastFirstTask = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "tasks:") {
      inTasks = true;
      continue;
    }
    if (inTasks && trimmed.startsWith("- name:")) {
      pastFirstTask = true;
      continue;
    }
    if (pastFirstTask && trimmed && !line.startsWith(" ") && !line.startsWith("\t")) {
      // Found the start of content after our block
      endOffset = lines.slice(0, i).join("\n").length;
      break;
    }
  }

  const after = content.slice(markerIdx + endOffset).trimStart();
  const updated = after ? before + "\n\n" + after : before + "\n";
  fs.writeFileSync(heartbeatPath, updated, "utf-8");
}

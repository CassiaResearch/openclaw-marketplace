import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Write a file atomically using a temp file + rename pattern.
 * Mirrors Hermes Agent's _atomic_write_text() in skill_manager_tool.py.
 *
 * On POSIX, renameSync is atomic when source and target are on the same
 * filesystem — which they always are since the temp file is in the same directory.
 * On error, the orphaned temp file is cleaned up before re-throwing.
 */
export function atomicWriteFileSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
  try {
    fs.writeFileSync(tmpPath, content, { mode: 0o644 });
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors — the write failure is what matters.
    }
    throw err;
  }
}

/**
 * Atomically remove a directory and all its contents.
 */
export function removeSkillDirSync(skillDir: string): void {
  fs.rmSync(skillDir, { recursive: true, force: true });
}

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { CachedSessionToolkits, SessionToolkitInfo } from "./types.js";

const STATE_DIR = join(homedir(), ".openclaw", "state", "composio-plus");

// Keyed on (baseURL, userId) — switching Composio identity must not pick up
// the previous identity's cached toolkits.
function cacheFilePath(baseURL: string, userId: string): string {
  const hash = createHash("sha256").update(`${baseURL}|${userId}`).digest("hex").slice(0, 16);
  return join(STATE_DIR, `session-toolkits-${hash}.json`);
}

export function readSessionToolkitsCache(
  baseURL: string,
  userId: string,
): (CachedSessionToolkits & { ageMs: number }) | null {
  const path = cacheFilePath(baseURL, userId);
  try {
    const stat = statSync(path);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CachedSessionToolkits;
    if (!parsed || !Array.isArray(parsed.toolkits)) return null;
    return { ...parsed, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

export function writeSessionToolkitsCache(
  baseURL: string,
  userId: string,
  toolkits: SessionToolkitInfo[],
): string {
  const path = cacheFilePath(baseURL, userId);
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const payload: CachedSessionToolkits = { toolkits, fetchedAt: Date.now() };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

export function sessionToolkitsCachePath(baseURL: string, userId: string): string {
  return cacheFilePath(baseURL, userId);
}

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { CachedMetaTool } from "./types.js";

const STATE_DIR = join(homedir(), ".openclaw", "state", "composio-plus");

function cacheFilePath(baseURL: string): string {
  const hash = createHash("sha256").update(baseURL).digest("hex").slice(0, 16);
  return join(STATE_DIR, `meta-tools-${hash}.json`);
}

export function readMetaToolCache(baseURL: string): {
  tools: CachedMetaTool[];
  ageMs: number;
} | null {
  const path = cacheFilePath(baseURL);
  try {
    const stat = statSync(path);
    const tools = JSON.parse(readFileSync(path, "utf-8")) as CachedMetaTool[];
    if (!Array.isArray(tools) || tools.length === 0) return null;
    return { tools, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

export function writeMetaToolCache(baseURL: string, tools: CachedMetaTool[]): string {
  const path = cacheFilePath(baseURL);
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, JSON.stringify(tools, null, 2));
  return path;
}

export function metaToolCachePath(baseURL: string): string {
  return cacheFilePath(baseURL);
}

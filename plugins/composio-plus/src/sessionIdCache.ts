import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const STATE_DIR = join(homedir(), ".openclaw", "state", "composio-plus");

// Keyed on (baseURL, userId) so switching Composio identity (or pointing at a
// different backend) starts a fresh session instead of replaying a stale id.
function cacheFilePath(baseURL: string, userId: string): string {
  const hash = createHash("sha256").update(`${baseURL}|${userId}`).digest("hex").slice(0, 16);
  return join(STATE_DIR, `session-id-${hash}.json`);
}

type CachedSessionId = {
  sessionId: string;
  // sha256 of the toolkit/authConfig fields passed to session.update() at the
  // time of the last create() or update() call. On reuse, we skip update() if
  // this matches the current config — avoids a redundant HTTP round-trip.
  configHash?: string;
};

export type SessionIdCacheEntry = {
  sessionId: string;
  configHash: string | null;
};

/** Deterministic hash of the fields that session.update() can change. */
export function hashUpdatePayload(payload: Record<string, unknown>): string {
  // Sort keys + arrays for determinism regardless of insertion order.
  const stable = JSON.stringify(payload, (_, v) =>
    Array.isArray(v) ? [...v].sort() : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

export function readSessionIdCache(baseURL: string, userId: string): SessionIdCacheEntry | null {
  const path = cacheFilePath(baseURL, userId);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CachedSessionId;
    if (!parsed || typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      configHash: typeof parsed.configHash === "string" ? parsed.configHash : null,
    };
  } catch {
    return null;
  }
}

export function writeSessionIdCache(
  baseURL: string,
  userId: string,
  sessionId: string,
  configHash?: string,
): string {
  const path = cacheFilePath(baseURL, userId);
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const payload: CachedSessionId = { sessionId, ...(configHash ? { configHash } : {}) };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

export function clearSessionIdCache(baseURL: string, userId: string): void {
  const path = cacheFilePath(baseURL, userId);
  try {
    unlinkSync(path);
  } catch {
    // missing file is fine; any other error we swallow to keep bootstrap unblocked
  }
}

export function sessionIdCachePath(baseURL: string, userId: string): string {
  return cacheFilePath(baseURL, userId);
}

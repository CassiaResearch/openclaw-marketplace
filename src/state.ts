import type { Tool, McpClientLike } from "./types.js";

// Uses globalThis + Symbol.for() so the cache survives Rolldown chunk
// duplication and multiple loadOpenClawPlugins calls (see openclaw#30784).

type ComposioState = {
  toolsCache: Map<string, { tools: Tool[]; error?: string }>;
  mcpClientCache: Map<string, Promise<McpClientLike | null>>;
};

const STATE_KEY = Symbol.for("composio:pluginState");
(globalThis as Record<symbol, unknown>)[STATE_KEY] ??= {
  toolsCache: new Map(),
  mcpClientCache: new Map(),
};

const state = (globalThis as Record<symbol, unknown>)[STATE_KEY] as ComposioState;

export const toolsCache = state.toolsCache;
export const mcpClientCache = state.mcpClientCache;

export function cacheKey(mcpUrl: string, consumerKey: string, apiKey: string = "", userId: string = "") {
  return `${mcpUrl}\0${consumerKey}\0${apiKey}\0${userId}`;
}

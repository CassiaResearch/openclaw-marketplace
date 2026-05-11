export type ComposioPlusConfig = {
  enabled: boolean;
  apiKey: string;
  userId: string;
  baseURL: string;
  toolkits: string[];
  /**
   * Disallowlist for the session. When non-empty, the session is created with
   * `toolkits: { disable: [...] }` — every toolkit in Composio's catalog except
   * these is callable. Mutually exclusive with `toolkits` (operator picks one
   * mode); set both and `disabledToolkits` wins.
   */
  disabledToolkits: string[];
  authConfigs: Record<string, string>;
};

export type CachedMetaTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** One toolkit in the session's allowlist with its current connection status. */
export type SessionToolkitInfo = {
  slug: string;
  name: string;
  isActive: boolean;
};

export type CachedSessionToolkits = {
  toolkits: SessionToolkitInfo[];
  fetchedAt: number;
};

export type ComposioPlusConfig = {
  enabled: boolean;
  apiKey: string;
  userId: string;
  baseURL: string;
  toolkits: string[];
  authConfigs: Record<string, string>;
};

export type CachedMetaTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export interface PluginConfig {
  langsmithApiKey: string | undefined;
  langsmithEndpoint: string;
  projectName: string;
  traceAgentTurns: boolean;
  traceToolCalls: boolean;
  batchIntervalMs: number;
  batchMaxSize: number;
  debug: boolean;
}

export interface LangSmithRun {
  id: string;
  trace_id: string;
  dotted_order: string;
  name: string;
  run_type: "chain" | "tool" | "llm";
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  parent_run_id?: string;
  start_time: string;
  end_time?: string;
  error?: string;
  extra?: Record<string, unknown>;
  session_name: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  tags?: string[];
}

import { describe, expect, it } from "vitest";
import { getMcpClient, resetMcpClient } from "../src/client.js";
import { discoverTools } from "../src/tools/discover.js";
import { registerDiscoveredTools } from "../src/tools/register.js";
import type { Log } from "../src/log.js";
import type { ExploriumConfig } from "../src/types.js";

const apiKey = process.env.EXPLORIUM_API_KEY;
const describeLive = apiKey ? describe : describe.skip;

const cfg: ExploriumConfig = {
  enabled: true,
  apiKey: apiKey ?? "",
  mcpUrl: "https://mcp.explorium.ai/mcp",
  authHeader: "api_key",
  authValuePrefix: "",
  debug: false,
};

const log: Log = {
  info: (m) => console.log("[info]", m),
  warn: (m) => console.warn("[warn]", m),
  error: (m) => console.error("[error]", m),
  debug: () => {},
};

describeLive("live Explorium MCP", () => {
  it("connects, discovers tools, and registers them via the plugin pipeline", async () => {
    const client = await getMcpClient(cfg, log);
    expect(client).not.toBeNull();
    if (!client) return;

    try {
      const tools = await discoverTools(client);
      console.log(`discovered ${tools.length} tools:`, tools.map((t) => t.name).join(", "));
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) {
        expect(typeof t.name).toBe("string");
        expect(t.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      }

      const registered: { name: string; execute: (id: string, p: unknown) => Promise<unknown> }[] =
        [];
      const api = {
        registerTool: (t: {
          name: string;
          execute: (id: string, p: unknown) => Promise<unknown>;
        }) => registered.push({ name: t.name, execute: t.execute }),
      } as unknown as Parameters<typeof registerDiscoveredTools>[0];

      const count = registerDiscoveredTools(api, tools, client, log);
      expect(count).toBe(tools.length);
      expect(registered.map((r) => r.name)).toEqual(tools.map((t) => t.name));

      // Smoke-test one read-only tool round-trip.
      const auto = registered.find((r) => r.name === "autocomplete");
      if (auto) {
        const res = (await auto.execute("test-1", {
          field: "job_title",
          query: "engineer",
        })) as { content: { text: string }[]; isError?: boolean };
        console.log("autocomplete full response:\n", res.content[0]?.text);
        expect(res.isError).not.toBe(true);
        expect(res.content[0]?.text?.length ?? 0).toBeGreaterThan(0);
      }
    } finally {
      await resetMcpClient();
    }
  }, 30_000);
});

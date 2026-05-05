import { describe, expect, it, vi } from "vitest";
import { registerDiscoveredTools } from "../src/tools/register.js";
import type { Log } from "../src/log.js";
import type { McpClientLike, McpTool } from "../src/types.js";

const silentLog: Log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeClient(
  callTool: McpClientLike["callTool"] = vi.fn() as unknown as McpClientLike["callTool"],
): McpClientLike {
  return {
    listTools: async () => ({ tools: [] }),
    callTool,
  };
}

describe("registerDiscoveredTools", () => {
  it("registers one OpenClaw tool per discovered MCP tool", () => {
    const tools: McpTool[] = [
      { name: "match-business", description: "match", inputSchema: { type: "object" } },
      { name: "fetch-businesses", inputSchema: { type: "object" } },
    ];
    const registerTool = vi.fn();
    const api = { registerTool } as unknown as Parameters<typeof registerDiscoveredTools>[0];

    const count = registerDiscoveredTools(api, tools, makeClient(), silentLog);

    expect(count).toBe(2);
    expect(registerTool).toHaveBeenCalledTimes(2);
    expect(registerTool.mock.calls[0]?.[0]).toMatchObject({ name: "match-business" });
  });

  it("forwards execute() args to client.callTool and flattens text content", async () => {
    const callTool = vi.fn(async () => ({
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    }));
    const client = makeClient(callTool as unknown as McpClientLike["callTool"]);
    let captured: { execute: (id: string, p: unknown) => Promise<unknown> } | undefined;
    const api = {
      registerTool: (t: { execute: (id: string, p: unknown) => Promise<unknown> }) => {
        captured = t;
      },
    } as unknown as Parameters<typeof registerDiscoveredTools>[0];

    registerDiscoveredTools(api, [{ name: "match-business" }], client, silentLog);
    const result = (await captured!.execute("call-1", { foo: 1 })) as {
      content: { text: string }[];
      isError?: boolean;
    };

    expect(callTool).toHaveBeenCalledWith({
      name: "match-business",
      arguments: { foo: 1 },
    });
    expect(result.content[0]?.text).toContain("hello");
    expect(result.content[0]?.text).toContain("world");
    expect(result.isError).toBeUndefined();
  });

  it("returns isError when callTool throws", async () => {
    const client = makeClient(
      vi.fn(async () => {
        throw new Error("boom");
      }) as unknown as McpClientLike["callTool"],
    );
    let captured: { execute: (id: string, p: unknown) => Promise<unknown> } | undefined;
    const api = {
      registerTool: (t: { execute: (id: string, p: unknown) => Promise<unknown> }) => {
        captured = t;
      },
    } as unknown as Parameters<typeof registerDiscoveredTools>[0];

    registerDiscoveredTools(api, [{ name: "x" }], client, silentLog);
    const result = (await captured!.execute("c", {})) as {
      content: { text: string }[];
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("boom");
  });
});

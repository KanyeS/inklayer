// @vitest-environment node
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { McpServer, type Tool, text } from "../src/mcp";

const echo: Tool = {
  name: "echo",
  description: "Says it back",
  inputSchema: { type: "object", properties: { say: { type: "string" } }, required: ["say"] },
  readOnly: true,
  run: async (a) => [text(String(a.say))],
};
const broken: Tool = {
  name: "broken",
  description: "Always fails",
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    throw new Error("No page is open.");
  },
};
const server = new McpServer({ name: "test", version: "1" }, "How to use it.", [echo, broken]);

describe("MCP server", () => {
  it("introduces itself in the client's protocol version, with its instructions", async () => {
    const reply = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "test", version: "1" },
        instructions: "How to use it.",
      },
    });
    const newer = (await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    })) as {
      result: { protocolVersion: string };
    };
    expect(newer.result.protocolVersion).toBe("2025-11-25");
  });

  it("lists its tools with their schemas", async () => {
    const reply = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    };
    expect(reply.result.tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([
      ["echo", true],
      ["broken", false],
    ]);
  });

  it("runs tools, and reports their failures to the model", async () => {
    expect(
      await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { say: "hi" } },
      }),
    ).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hi" }] } });
    expect(await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "broken" } })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "No page is open." }], isError: true },
    });
  });

  it("refuses unknown tools and methods, and doesn't answer notifications", async () => {
    expect(
      await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } }),
    ).toMatchObject({
      error: { code: -32602 },
    });
    expect(await server.handle({ jsonrpc: "2.0", id: 1, method: "resources/list" })).toMatchObject({
      error: { code: -32601 },
    });
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("speaks newline-delimited JSON over a stream", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (d: Buffer) => lines.push(...d.toString().split("\n").filter(Boolean)));
    const served = server.serve(input, output);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    input.write("not json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.end();
    await served;
    // Answers go out as each is ready, not necessarily in order.
    const replies = lines.map((l) => JSON.parse(l));
    expect(replies).toHaveLength(2);
    expect(replies).toContainEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(replies).toContainEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Not JSON." } });
  });
});

import { createInterface } from "node:readline";

/**
 * Just enough of the Model Context Protocol (https://modelcontextprotocol.io) for a local server with tools, over stdio:
 * JSON-RPC 2.0, one message per line. Claude Code starts the server, says hello (initialize), lists the tools and calls
 * them. Written here rather than taking the SDK, which brings a web framework this server has no use for.
 * Unit-tested: test/mcp.test.ts.
 */

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Read-only tools only look; the others change something (in the browser or on the Inklayer server). */
  readOnly?: boolean;
  run(args: Record<string, unknown>): Promise<Content[]>;
}

interface Message {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Protocol versions this server speaks, newest first. */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const PARSE_ERROR = -32700;

export class McpServer {
  readonly #tools: Map<string, Tool>;
  readonly #info: { name: string; version: string };
  readonly #instructions: string;

  constructor(info: { name: string; version: string }, instructions: string, tools: Tool[]) {
    this.#info = info;
    this.#instructions = instructions;
    this.#tools = new Map(tools.map((t) => [t.name, t]));
  }

  /** Answers one message; null for notifications, which get no answer. */
  async handle(message: Message): Promise<object | null> {
    if (message.id === undefined || message.id === null) return null;
    const ok = (result: object) => ({ jsonrpc: "2.0", id: message.id, result });
    const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
    switch (message.method) {
      case "initialize": {
        const asked = String(message.params?.protocolVersion ?? "");
        return ok({
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: this.#info,
          instructions: this.#instructions,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: [...this.#tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: t.readOnly === true },
          })),
        });
      case "tools/call": {
        const tool = this.#tools.get(String(message.params?.name ?? ""));
        if (!tool) return fail(INVALID_PARAMS, `Unknown tool: ${String(message.params?.name)}`);
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          return ok({ content: await tool.run(args) });
        } catch (error) {
          // A tool that fails tells the model why, so it can try something else.
          return ok({ content: [{ type: "text", text: errorText(error) }], isError: true });
        }
      }
      default:
        return fail(METHOD_NOT_FOUND, `Unknown method: ${String(message.method)}`);
    }
  }

  /** Serves on stdin and stdout until stdin closes. Logs go to stderr, which Claude Code keeps out of the protocol. */
  serve(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
    const write = (reply: object) => output.write(`${JSON.stringify(reply)}\n`);
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    const pending = new Set<Promise<void>>();
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Not JSON." } });
        return;
      }
      // Tools can take a while (a page loading, sign-in): keep answering other messages meanwhile.
      const work = this.handle(message).then((reply) => {
        if (reply) write(reply);
      });
      pending.add(work);
      void work.finally(() => pending.delete(work));
    });
    return new Promise((resolve) =>
      lines.on("close", () => {
        void Promise.all(pending).then(() => resolve());
      }),
    );
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const text = (value: string): Content => ({ type: "text", text: value });
export const image = (bytes: Buffer, mimeType = "image/jpeg"): Content => ({
  type: "image",
  data: bytes.toString("base64"),
  mimeType,
});

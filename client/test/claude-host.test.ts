import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain JavaScript module without types
import { claudeCommand } from "../../claude-plugin/improve/inklayer-claude-host.mjs";

/** The native messaging host (claude-plugin/improve/inklayer-claude-host.mjs), run as the browser runs it, with a fake claude. */

const HOST = join(__dirname, "..", "..", "claude-plugin", "improve", "inklayer-claude-host.mjs");
const dir = mkdtempSync(join(tmpdir(), "inklayer-host-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for the claude CLI: a shell script that prints `stdout` (after saving its stdin and arguments). */
function fakeClaude(name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function ask(claude: string, message: unknown, env: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], { env: { PATH: process.env.PATH, INKLAYER_CLAUDE: claude, ...env } });
    let out = Buffer.alloc(0);
    child.stdout.on("data", (d: Buffer) => {
      out = Buffer.concat([out, d]);
    });
    child.on("error", reject);
    child.on("close", () => {
      const length = out.readUInt32LE(0);
      expect(out.length).toBe(4 + length);
      resolve(JSON.parse(out.subarray(4).toString("utf8")));
    });
    child.stdin.end(frame(message));
  });
}

describe("Claude helper host", () => {
  it("answers a ping with the Claude Code version", async () => {
    const claude = fakeClaude("version", 'echo "2.1.0 (Claude Code)"');
    expect(await ask(claude, { type: "ping" })).toEqual({ ok: true, version: "1", claude: "2.1.0 (Claude Code)" });
  });

  it("sends the draft with its page to claude, without tools, and returns the rewrite", async () => {
    const seen = join(dir, "seen");
    const claude = fakeClaude(
      "improve",
      `cat > ${seen}.in; printf '%s\\n' "$@" > ${seen}.args; echo '{"type":"result","is_error":false,"result":"  Clear comment.  ","total_cost_usd":0.02,"duration_ms":4200,"usage":{"input_tokens":12,"cache_creation_input_tokens":3000,"cache_read_input_tokens":100,"output_tokens":80},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":1182,"outputTokens":12,"canonicalModel":"claude-haiku-4-5"},"claude-sonnet-4-6":{"inputTokens":12,"cacheCreationInputTokens":3000,"cacheReadInputTokens":100,"outputTokens":80,"canonicalModel":"claude-sonnet-4-6"}}}'`,
    );
    const reply = await ask(claude, {
      type: "improve",
      text: "it broke",
      url: "https://site.example/",
      page: {
        title: "Settings",
        outline: ["Account", "Email"],
        section: "Email me@example.com Save",
        element: { tag: "button", selector: "form > button", text: "Save" },
        quote: "Save",
      },
    });
    // With what it used: tokens in (cached or not) and out, cost at API prices, model and time.
    expect(reply).toEqual({
      ok: true,
      text: "Clear comment.",
      // Both models' tokens, named after the one that wrote the answer.
      usage: { inputTokens: 4294, outputTokens: 92, costUsd: 0.02, model: "claude-sonnet-4-6", durationMs: 4200 },
    });
    const input = readFileSync(`${seen}.in`, "utf8");
    expect(input).toContain("<draft>\nit broke\n</draft>");
    expect(input).toContain("<page_url>\nhttps://site.example/\n</page_url>");
    expect(input).toContain("<page_headings>\nAccount\nEmail\n</page_headings>");
    expect(input).toContain("<element>\ntag: button\nselector: form > button\n</element>");
    expect(input).toContain("<highlighted_text>\nSave\n</highlighted_text>");
    const args = readFileSync(`${seen}.args`, "utf8").split("\n");
    expect(args).toContain("-p");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    // The system prompt goes in a file next to it, not on the command line.
    expect(args[args.indexOf("--system-prompt-file") + 1]).toMatch(/system-prompt\.txt$/);
  });

  it("passes on Claude Code's errors", async () => {
    const claude = fakeClaude("error", 'echo "Invalid API key · Please run /login" >&2; exit 1');
    expect(await ask(claude, { type: "improve", text: "x" })).toEqual({
      ok: false,
      error: "Invalid API key · Please run /login",
    });
  });

  it("says when Claude Code isn't installed", async () => {
    const reply = (await ask(join(dir, "missing"), { type: "ping" })) as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("isn't installed");
  });

  it("gives up on a claude that hangs", async () => {
    const claude = fakeClaude("hang", "sleep 10");
    expect(await ask(claude, { type: "improve", text: "x" }, { INKLAYER_CLAUDE_TIMEOUT_MS: "300" })).toEqual({
      ok: false,
      error: "Claude took too long to answer.",
    });
  });

  it("refuses an empty draft and unknown requests", async () => {
    const claude = fakeClaude("unused", "exit 1");
    expect(await ask(claude, { type: "improve", text: " " })).toEqual({ ok: false, error: "Nothing to improve." });
    expect(await ask(claude, { type: "delete-everything" })).toEqual({ ok: false, error: "Unknown request." });
  });

  it("starts claude.cmd through cmd.exe on Windows, every argument quoted", () => {
    const run = claudeCommand(
      ["-p", "--tools", "", "--system-prompt-file", "C:\\Temp\\a b\\p.txt"],
      "win32",
      "C:\\npm\\claude.cmd",
    );
    expect(run.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\npm\\claude.cmd" "-p" "--tools" "" "--system-prompt-file" "C:\\Temp\\a b\\p.txt""',
    ]);
    expect(run.options).toEqual({ windowsVerbatimArguments: true });
    expect(claudeCommand(["-p"], "win32", "C:\\claude\\claude.exe")).toEqual({
      command: "C:\\claude\\claude.exe",
      args: ["-p"],
      options: {},
    });
    expect(claudeCommand(["-p"], "linux", "/usr/bin/claude").command).toBe("/usr/bin/claude");
  });
});

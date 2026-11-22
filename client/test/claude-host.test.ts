import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/** The native messaging host (native-host/inklayer-claude-host.mjs), run as the browser runs it, with a fake claude. */

const HOST = join(__dirname, "..", "apps", "extension", "native-host", "inklayer-claude-host.mjs");
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
      `cat > ${seen}.in; printf '%s\\n' "$@" > ${seen}.args; echo '{"type":"result","is_error":false,"result":"  Clear comment.  "}'`,
    );
    const reply = await ask(claude, {
      type: "improve",
      text: "it broke",
      url: "https://site.example/",
      elementText: "Save",
    });
    expect(reply).toEqual({ ok: true, text: "Clear comment." });
    const input = readFileSync(`${seen}.in`, "utf8");
    expect(input).toContain("<draft>it broke</draft>");
    expect(input).toContain("<page_url>https://site.example/</page_url>");
    const args = readFileSync(`${seen}.args`, "utf8").split("\n");
    expect(args).toContain("-p");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
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
});

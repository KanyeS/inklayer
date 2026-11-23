import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The Claude Code plugin at the repository's root (claude-plugin/), which people install from GitHub, so what it
 * ships is committed: the review helper's build, and the files its hook and MCP server name.
 * @vitest-environment node
 */

const REPO = resolve(import.meta.dirname, "../..");
const PLUGIN = join(REPO, "claude-plugin");
const out = mkdtempSync(join(tmpdir(), "inklayer-plugin-build-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("Claude Code plugin", () => {
  it("ships the review helper as it builds now (run `pnpm --filter @inklayer/review build` and commit)", () => {
    // Built from the helper's own folder, as pnpm runs it: the bundle's comments name files relative to it.
    const script = `import { build } from "vite";
      for (const mode of ["page", "production"]) await build({ mode, logLevel: "silent", build: { outDir: ${JSON.stringify(out)} } });`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: join(REPO, "client/apps/review") });
    for (const file of ["page.js", "server.mjs"]) {
      expect(readFileSync(join(PLUGIN, "review", file), "utf8"), file).toBe(readFileSync(join(out, file), "utf8"));
    }
  }, 60_000);

  it("pins the review helper's one dependency to the version the workspace builds with", () => {
    const shipped = json(join(PLUGIN, "package.json")).dependencies;
    const workspace = json(join(REPO, "client/apps/review/package.json")).dependencies;
    expect(shipped).toEqual({ "playwright-core": workspace["playwright-core"] });
    const lock = json(join(PLUGIN, "package-lock.json"));
    expect(lock.packages["node_modules/playwright-core"].version).toBe(workspace["playwright-core"]);
  });

  it("names files that exist, and a marketplace entry that points at it", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's own placeholder, as the plugin's files write it
    const root = (path: string) => path.replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN);
    const hook = json(join(PLUGIN, "hooks/hooks.json")).hooks.SessionStart[0].hooks[0];
    expect(existsSync(root(hook.args[0]))).toBe(true);
    for (const server of Object.values(json(join(PLUGIN, ".mcp.json")).mcpServers) as { args: string[] }[]) {
      expect(existsSync(root(server.args[0] ?? ""))).toBe(true);
    }
    const marketplace = json(join(REPO, ".claude-plugin/marketplace.json"));
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "inklayer", source: "./claude-plugin" })]);
    expect(json(join(PLUGIN, ".claude-plugin/plugin.json")).name).toBe("inklayer");
    expect(existsSync(join(PLUGIN, "skills/review-feature/SKILL.md"))).toBe(true);
  });
});

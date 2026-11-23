import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { crc32, installerFor, unixInstaller, windowsInstaller, zip } from "../apps/extension/src/lib/helper-installers";

/**
 * The Improve helper's downloadable installers, made by the extension's popup. They're run here for real, in a home
 * folder of their own with a stand-in claude, then the helper they installed is asked who it is.
 * @vitest-environment node
 */

const dir = mkdtempSync(join(tmpdir(), "inklayer-installers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A home folder with Chrome's folder and a fake claude on PATH. */
function home(name: string): { env: NodeJS.ProcessEnv; root: string } {
  const root = join(dir, name);
  mkdirSync(join(root, ".config", "google-chrome"), { recursive: true });
  mkdirSync(join(root, ".mozilla"), { recursive: true });
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "claude"), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, PATH: `${join(root, "bin")}:${process.env.PATH}` };
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  return { env, root };
}

/** Pings the installed helper through its wrapper, as Chrome would. */
function ping(wrapper: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(wrapper, [], { env: { PATH: "/usr/bin:/bin" } });
    let out = Buffer.alloc(0);
    child.stdout.on("data", (d: Buffer) => {
      out = Buffer.concat([out, d]);
    });
    child.on("error", reject);
    child.on("close", () => resolve(JSON.parse(out.subarray(4).toString("utf8"))));
    const body = Buffer.from(JSON.stringify({ type: "ping" }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin.end(Buffer.concat([header, body]));
  });
}

const manifestOf = (root: string) =>
  JSON.parse(
    readFileSync(join(root, ".config", "google-chrome", "NativeMessagingHosts", "com.inklayer.claude.json"), "utf8"),
  );

describe.runIf(process.platform !== "win32")("downloaded installers", () => {
  it("the macOS and Linux installer installs the helper with the shell, and it answers", async () => {
    const { env, root } = home("unix");
    const file = join(root, "install-inklayer-improve.sh");
    writeFileSync(file, unixInstaller());
    const run = spawnSync("sh", [file], { env, encoding: "utf8", input: "" });
    expect(run.stdout).toContain("Installed.");
    expect(run.status).toBe(0);
    const manifest = manifestOf(root);
    expect(manifest.allowed_origins).toEqual(["chrome-extension://cihhaaceflhcncmeoiembekghkhbgfio/"]);
    // Firefox names the add-on that may start it by its ID.
    const firefox = JSON.parse(
      readFileSync(join(root, ".mozilla", "native-messaging-hosts", "com.inklayer.claude.json"), "utf8"),
    );
    expect(firefox).toMatchObject({ path: manifest.path, allowed_extensions: ["inklayer-extension@inklayer"] });
    expect(await ping(manifest.path)).toEqual({ ok: true, version: "1", claude: "9.9.9 (Claude Code)" });
  });

  // The installer also looks where Homebrew and other installers put node (a double-click gets a short PATH), so this
  // only shows on a machine with no node there (not GitHub's runners, which have one in /usr/local/bin).
  const nodeInUsualPlaces = ["/usr/local/bin/node", "/opt/homebrew/bin/node"].some((p) => existsSync(p));
  it.skipIf(nodeInUsualPlaces)("says Node.js is needed when there isn't one", () => {
    const { root } = home("no-node");
    const file = join(root, "install.sh");
    writeFileSync(file, unixInstaller());
    const run = spawnSync("/bin/sh", [file], { env: { HOME: root, PATH: "/nowhere" }, encoding: "utf8", input: "" });
    expect(run.stdout).toContain("needs Node.js");
    expect(run.status).toBe(1);
  });

  it("the Windows installer's JavaScript runs (here on Node directly), behind its batch lines", async () => {
    const script = windowsInstaller();
    expect(script.startsWith("0</* :\r\n@echo off\r\n")).toBe(true);
    expect(script).not.toMatch(/[^\r]\n/);
    const { env, root } = home("windows");
    const file = join(root, "Install Inklayer Improve.cmd");
    writeFileSync(file, script);
    const run = spawnSync(process.execPath, [file], { env, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("Installed.");
    expect(await ping(manifestOf(root).path)).toMatchObject({ ok: true });
  });
});

describe("installer files", () => {
  it("names and explains each system's file", () => {
    expect(installerFor("win").fileName).toBe("Install Inklayer Improve.cmd");
    expect(installerFor("mac").fileName).toBe("Install Inklayer Improve.zip");
    expect(installerFor("linux").howTo).toContain("sh ~/Downloads/install-inklayer-improve.sh");
  });

  it("zips the macOS installer so it stays runnable", () => {
    const content = new TextEncoder().encode("#!/bin/sh\necho hi\n");
    const archive = zip("Install.command", content, 0o755);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const python = spawnSync("python3", ["--version"]);
    if (python.status !== 0) return;
    const path = join(dir, "check.zip");
    writeFileSync(path, archive);
    const listed = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); i=z.infolist()[0]; print(i.filename, oct(i.external_attr>>16), z.read(i).decode(), z.testzip())",
        path,
      ],
      { encoding: "utf8" },
    );
    expect(listed).toBe("Install.command 0o100755 #!/bin/sh\necho hi\n None\n");
    expect(existsSync(path)).toBe(true);
  });
});

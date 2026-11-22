#!/usr/bin/env node
// Installs Inklayer's local Claude helper for Chromium browsers (Chrome, Chromium, Brave, Edge) on Linux and macOS, so
// the extension's "Improve" button can use the Claude Code CLI signed in on this computer.
//
//   node install.mjs              install (or update)
//   node install.mjs --uninstall  remove it
//
// Browsers start helpers with a minimal PATH, so this records where node and claude are now, in a small wrapper.
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "com.inklayer.claude";
/** The Web Store extension ID, which the manifest's "key" also gives builds from source. */
const EXTENSION_ID = process.env.INKLAYER_EXTENSION_ID || "cihhaaceflhcncmeoiembekghkhbgfio";

const home = homedir();
const os = platform();

/** Where each browser keeps its own folders; a helper's manifest goes in <that>/NativeMessagingHosts. */
function browserDirs() {
  if (os === "darwin") {
    const support = join(home, "Library", "Application Support");
    return ["Google/Chrome", "Google/Chrome Beta", "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge"].map(
      (d) => join(support, d),
    );
  }
  if (os === "linux") {
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    return ["google-chrome", "google-chrome-beta", "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge"].map(
      (d) => join(config, d),
    );
  }
  return null;
}

function installDir() {
  return os === "darwin"
    ? join(home, "Library", "Application Support", "InkLayer")
    : join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "inklayer");
}

/** The first executable called `name` on PATH. */
function which(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

function install(dirs) {
  const claude = which("claude");
  if (!claude) {
    console.error(
      "Couldn't find the claude command. Install Claude Code and sign in first: https://claude.com/claude-code",
    );
    process.exit(1);
  }
  const dir = installDir();
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "inklayer-claude-host.mjs");
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "inklayer-claude-host.mjs"), script);

  const wrapper = join(dir, "claude-host");
  const path = [...new Set([dirname(process.execPath), dirname(claude), "/usr/local/bin", "/usr/bin", "/bin"])];
  writeFileSync(
    wrapper,
    `#!/bin/sh
# Inklayer's local Claude helper, started by the browser. Written by install.mjs; run it again to update.
export PATH=${shellQuote(path.join(":"))}
export INKLAYER_CLAUDE=${shellQuote(claude)}
exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"
`,
  );
  chmodSync(wrapper, 0o755);

  const manifest = JSON.stringify(
    {
      name: HOST_NAME,
      description: "Inklayer: improve comments with the Claude Code CLI on this computer",
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  );
  // Browsers that are installed (have their folder); Chrome's anyway if none are found yet.
  const present = dirs.filter((d) => existsSync(d));
  const targets = present.length > 0 ? present : [dirs[0]];
  for (const d of targets) {
    const hosts = join(d, "NativeMessagingHosts");
    mkdirSync(hosts, { recursive: true });
    writeFileSync(join(hosts, `${HOST_NAME}.json`), `${manifest}\n`);
    console.log(`Registered for ${d}`);
  }
  console.log(`\nInstalled. It uses ${claude} with ${process.execPath}.`);
  console.log('In the Inklayer popup, open Settings and turn on "Improve comments with Claude".');
}

function uninstall(dirs) {
  for (const d of dirs) rmSync(join(d, "NativeMessagingHosts", `${HOST_NAME}.json`), { force: true });
  rmSync(installDir(), { recursive: true, force: true });
  console.log("Removed Inklayer's Claude helper.");
}

const dirs = browserDirs();
if (!dirs) {
  console.error("The Claude helper installs on Linux and macOS for now; Windows isn't supported yet.");
  process.exit(1);
}
if (process.argv.includes("--uninstall")) uninstall(dirs);
else install(dirs);

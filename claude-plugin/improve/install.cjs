// Installs Inklayer's local Claude helper for Chromium browsers (Chrome, Chromium, Brave, Edge) on Linux, macOS and
// Windows, so the extension's "Improve" button can use the Claude Code CLI signed in on this computer.
//
//   node install.cjs              install (or update)
//   node install.cjs --quiet      the same, saying nothing unless something's wrong (the plugin's SessionStart hook)
//   node install.cjs --uninstall  remove it
//
// It runs three ways: from the Claude Code plugin (claude-plugin/, its hook runs it as each session starts), from a
// copy of the repository, and inside the installers the extension's popup downloads (which put the helper's source in
// globalThis.INKLAYER_HOST_SOURCE, since there's no file next to them). Plain CommonJS with no dependencies, so any
// Node.js 18 or later runs it, whatever the file is called.
//
// Browsers start helpers with a minimal PATH, so this records where node and claude are now, in a small wrapper.
// Browsers find helpers through a manifest file: in a folder of theirs on Linux and macOS, through the registry on Windows.
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { homedir, platform } = require("node:os");
const { delimiter, dirname, join } = require("node:path");

const HOST_NAME = "com.inklayer.claude";
/** The Web Store extension ID, which the manifest's "key" also gives builds from source. */
const EXTENSION_ID = process.env.INKLAYER_EXTENSION_ID || "cihhaaceflhcncmeoiembekghkhbgfio";

const home = homedir();
const os = platform();
const quiet = process.argv.includes("--quiet");
const say = (line) => {
  if (!quiet) console.log(line);
};

/** Linux and macOS: where each browser keeps its own folders; a helper's manifest goes in <that>/NativeMessagingHosts. */
function browserDirs() {
  if (os === "darwin") {
    const support = join(home, "Library", "Application Support");
    return ["Google/Chrome", "Google/Chrome Beta", "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge"].map(
      (d) => join(support, d),
    );
  }
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return ["google-chrome", "google-chrome-beta", "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge"].map((d) =>
    join(config, d),
  );
}

/** Windows: each browser's registry key for the helper, whose default value is the manifest's path. */
const REGISTRY_KEYS = ["Google\\Chrome", "Chromium", "BraveSoftware\\Brave-Browser", "Microsoft\\Edge"].map(
  (browser) => `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${HOST_NAME}`,
);

function installDir() {
  if (os === "win32") return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "InkLayer");
  return os === "darwin"
    ? join(home, "Library", "Application Support", "InkLayer")
    : join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "inklayer");
}

/**
 * Where to look for claude: PATH, then the places installers put it. A downloaded installer opened by double-click
 * gets the system's short PATH, without Homebrew's or the user's own folders.
 */
function searchPath() {
  const extra =
    os === "win32"
      ? [join(home, ".local", "bin"), join(process.env.APPDATA || "", "npm")]
      : [
          join(home, ".local", "bin"),
          join(home, ".claude", "local"),
          join(home, ".npm-global", "bin"),
          join(home, ".volta", "bin"),
          join(home, ".bun", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
        ];
  return [...(process.env.PATH || "").split(delimiter), ...extra].filter(Boolean);
}

/** The first executable called `name` (on Windows, with one of PATHEXT's endings, such as claude.cmd). */
function which(name) {
  const endings = os === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").toLowerCase().split(";") : [""];
  for (const dir of searchPath()) {
    for (const ending of endings) {
      const candidate = join(dir, name + ending);
      try {
        fs.accessSync(candidate, os === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** The helper's own source: embedded in a downloaded installer, otherwise the file next to this one. */
function hostSource() {
  if (typeof globalThis.INKLAYER_HOST_SOURCE === "string") return globalThis.INKLAYER_HOST_SOURCE;
  return fs.readFileSync(join(__dirname, "inklayer-claude-host.mjs"), "utf8");
}

/** Writes a file only if it changed, so running this as each session starts costs next to nothing. */
function write(file, content, mode) {
  let same = false;
  try {
    same = fs.readFileSync(file, "utf8") === content;
  } catch {
    // new
  }
  if (!same) fs.writeFileSync(file, content);
  if (mode) fs.chmodSync(file, mode);
}

const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

function shellWrapper(claude, script) {
  const path = [...new Set([dirname(process.execPath), dirname(claude), "/usr/local/bin", "/usr/bin", "/bin"])];
  return `#!/bin/sh
# Inklayer's local Claude helper, started by the browser. Written by install.cjs; run it again to update.
export PATH=${shellQuote(path.join(":"))}
export INKLAYER_CLAUDE=${shellQuote(claude)}
exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"
`;
}

/** Windows: browsers start a .bat (or .exe) helper. Paths are quoted; Windows paths can't contain quotes. */
function batchWrapper(claude, script) {
  return [
    "@echo off",
    "rem Inklayer's local Claude helper, started by the browser. Written by install.cjs; run it again to update.",
    `set "PATH=${dirname(process.execPath)};${dirname(claude)};%PATH%"`,
    `set "INKLAYER_CLAUDE=${claude}"`,
    `"${process.execPath}" "${script}" %*`,
    "",
  ].join("\r\n");
}

function install() {
  const claude = which("claude");
  if (!claude) {
    console.error(
      "Couldn't find Claude Code. Install it and sign in first (https://claude.com/claude-code), then run this again.",
    );
    process.exitCode = 1;
    return;
  }
  const dir = installDir();
  fs.mkdirSync(dir, { recursive: true });
  const script = join(dir, "inklayer-claude-host.mjs");
  write(script, hostSource());
  const wrapper = join(dir, os === "win32" ? "claude-host.bat" : "claude-host");
  if (os === "win32") write(wrapper, batchWrapper(claude, script));
  else write(wrapper, shellWrapper(claude, script), 0o755);

  const manifest = `${JSON.stringify(
    {
      name: HOST_NAME,
      description: "Inklayer: improve comments with the Claude Code CLI on this computer",
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  )}\n`;

  if (os === "win32") {
    const file = join(dir, `${HOST_NAME}.json`);
    write(file, manifest);
    for (const key of REGISTRY_KEYS) execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", file, "/f"], { stdio: "ignore" });
    say(`Registered for Chrome, Chromium, Brave and Edge (${file})`);
  } else {
    // Browsers that are installed (have their folder); Chrome's anyway if none are found yet.
    const dirs = browserDirs();
    const present = dirs.filter((d) => fs.existsSync(d));
    for (const d of present.length > 0 ? present : [dirs[0]]) {
      const hosts = join(d, "NativeMessagingHosts");
      fs.mkdirSync(hosts, { recursive: true });
      write(join(hosts, `${HOST_NAME}.json`), manifest);
      say(`Registered for ${d}`);
    }
  }
  say(`\nInstalled. It uses ${claude} with ${process.execPath}.`);
  say('In the Inklayer popup, open Settings and turn on "Improve comments with Claude".');
}

function uninstall() {
  if (os === "win32") {
    for (const key of REGISTRY_KEYS) {
      try {
        execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" });
      } catch {
        // not registered for this browser
      }
    }
  } else {
    for (const d of browserDirs()) fs.rmSync(join(d, "NativeMessagingHosts", `${HOST_NAME}.json`), { force: true });
  }
  fs.rmSync(installDir(), { recursive: true, force: true });
  say("Removed Inklayer's Claude helper.");
}

if (os !== "linux" && os !== "darwin" && os !== "win32") {
  console.error("The Claude helper installs on Linux, macOS and Windows.");
  process.exitCode = 1;
} else if (process.argv.includes("--uninstall")) {
  uninstall();
} else {
  install();
}

import hostSource from "@claude-plugin/improve/inklayer-claude-host.mjs?raw";
import installerSource from "@claude-plugin/improve/install.cjs?raw";

/**
 * Installers for the Improve button's local Claude helper, made here in the popup from the Claude Code plugin's own
 * files (claude-plugin/improve), so they always match the helper the plugin installs. Each is one file that is both a
 * script the system runs on a double-click and the Node.js installer (install.cjs), with the helper inside it:
 *  - macOS: a .command in a .zip (a downloaded file loses its permission to run; a zip keeps it),
 *  - Windows: a .cmd,
 *  - Linux: a .sh, run with `sh` (file managers don't run downloaded scripts).
 * They need Node.js and Claude Code; they say so if either is missing. Unit-tested: test/helper-installers.test.ts.
 */

export type InstallerOs = "mac" | "win" | "linux";

export interface InstallerFile {
  fileName: string;
  bytes: Uint8Array;
  type: string;
  /** How to run it, for the popup. */
  howTo: string;
}

/** The installer's JavaScript: the helper's source, then install.cjs, which reads it from there. */
export function installerScript(): string {
  return `globalThis.INKLAYER_HOST_SOURCE = ${JSON.stringify(hostSource)};\n${installerSource}`;
}

const NEEDS_NODE = "Inklayer needs Node.js for this. Install it from https://nodejs.org, then run this again.";

/**
 * macOS and Linux: a shell script whose second line, to Node, is a string and a comment. The shell finds node (a
 * double-clicked .command gets a short PATH, without Homebrew's or the user's folders) and runs this same file with it.
 */
export function unixInstaller(): string {
  const shell = [
    'for d in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$PATH:$d"; done; export PATH',
    `if command -v node >/dev/null 2>&1; then node "$0" "$@"; s=$?; else echo "${NEEDS_NODE}"; s=1; fi`,
    "if [ -t 0 ]; then printf '\\nPress Enter to close. '; read _; fi; exit $s",
  ].join("; ");
  return `#!/bin/sh\n":" //; ${shell}\n${installerScript()}`;
}

/**
 * Windows: a batch file that, to Node, starts with `0 < 0` around a comment. cmd.exe runs the lines inside the
 * comment (find node, run this same file with it, wait for a key) and stops before the JavaScript.
 */
export function windowsInstaller(): string {
  const batch = [
    "0</* :",
    "@echo off",
    "setlocal",
    `where node >nul 2>nul || (echo ${NEEDS_NODE} & pause & exit /b 1)`,
    'node "%~f0" %*',
    "set s=%errorlevel%",
    "pause",
    "exit /b %s%",
    "*/0;",
  ].join("\r\n");
  return `${batch}\r\n${installerScript().replaceAll(/\r?\n/g, "\r\n")}`;
}

const encoder = new TextEncoder();

export function installerFor(os: InstallerOs): InstallerFile {
  if (os === "win") {
    return {
      fileName: "Install Inklayer Improve.cmd",
      bytes: encoder.encode(windowsInstaller()),
      type: "application/octet-stream",
      howTo:
        'Open the downloaded file. If Windows says it protected your PC, choose "More info", then "Run anyway": the installer isn\'t signed.',
    };
  }
  if (os === "mac") {
    return {
      fileName: "Install Inklayer Improve.zip",
      bytes: zip("Install Inklayer Improve.command", encoder.encode(unixInstaller()), 0o755),
      type: "application/zip",
      howTo:
        "Open the zip, then the installer in it. If macOS won't open it, open System Settings → Privacy & Security and click \"Open Anyway\": the installer isn't signed.",
    };
  }
  return {
    fileName: "install-inklayer-improve.sh",
    bytes: encoder.encode(unixInstaller()),
    type: "text/x-shellscript",
    howTo: "In a terminal, run: sh ~/Downloads/install-inklayer-improve.sh",
  };
}

/* ---------------------------------------------------------------- zip */

/**
 * A zip with one file, stored (not compressed), marked as made on Unix with the given permissions, so macOS's Archive
 * Utility extracts it as runnable.
 */
export function zip(name: string, content: Uint8Array, mode: number): Uint8Array {
  const fileName = encoder.encode(name);
  const crc = crc32(content);
  // 2026-01-01 00:00, in DOS format: a fixed date, so the same files make the same zip.
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, 0x0800, true); // UTF-8 names
  local.setUint16(8, 0, true); // stored
  local.setUint16(10, time, true);
  local.setUint16(12, date, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, content.length, true);
  local.setUint32(22, content.length, true);
  local.setUint16(26, fileName.length, true);
  local.setUint16(28, 0, true);

  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, (3 << 8) | 20, true); // made on Unix, so the permissions below count
  central.setUint16(6, 20, true);
  central.setUint16(8, 0x0800, true);
  central.setUint16(10, 0, true);
  central.setUint16(12, time, true);
  central.setUint16(14, date, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, content.length, true);
  central.setUint32(24, content.length, true);
  central.setUint16(28, fileName.length, true);
  central.setUint32(38, ((0o100000 | mode) << 16) >>> 0, true); // a regular file with these permissions
  central.setUint32(42, 0, true); // where the local header starts

  const localSize = 30 + fileName.length + content.length;
  const centralSize = 46 + fileName.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, localSize, true);

  const parts = [
    new Uint8Array(local.buffer),
    fileName,
    content,
    new Uint8Array(central.buffer),
    fileName,
    new Uint8Array(end.buffer),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

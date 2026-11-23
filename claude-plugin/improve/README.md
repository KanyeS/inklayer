# Inklayer's local Claude helper

This is what makes the **Improve** button in the comment box work. It is a [native messaging host](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): a small program the browser starts when the extension asks it to. It passes the comment draft to the [Claude Code](https://claude.com/claude-code) CLI on this computer and returns the rewrite. The rewrite uses your own Claude Code sign-in and plan. Nothing goes to the Inklayer server until you save the comment.

## Install

Each person needs Claude Code (signed in) and Node.js. Then, one of:

- **Inklayer's Claude Code plugin** ([../README.md](../README.md)): its hook runs `install.cjs --quiet` each time Claude Code starts, which sets the helper up and keeps it up to date.
- **An installer from the extension's popup** (Settings → Improve comments with Claude → Download installer). The popup builds it from these two files: one file that the system runs (a `.command` in a zip on a Mac, a `.cmd` on Windows, a `.sh` on Linux) and that is also this installer, with the helper inside it. See `client/apps/extension/src/lib/helper-installers.ts`.
- **From a copy of the repository:** `node claude-plugin/improve/install.cjs`.

The install script does three things:

- It copies `inklayer-claude-host.mjs` to `~/.local/share/inklayer/` on Linux, `~/Library/Application Support/InkLayer/` on macOS, or `%LOCALAPPDATA%\InkLayer` on Windows.
- It writes a wrapper next to it (`claude-host`, or `claude-host.bat` on Windows). Browsers start helpers with a minimal `PATH`, so the wrapper records where `node` and `claude` are.
- It registers `com.inklayer.claude` with each browser: Chrome, Chromium, Brave and Edge in their `NativeMessagingHosts` folders on Linux and macOS, and Firefox in `~/.mozilla/native-messaging-hosts` (Linux) or `~/Library/Application Support/Mozilla/NativeMessagingHosts` (macOS), when it's installed. On Windows it adds each browser's `NativeMessagingHosts` key in the current user's registry. Only the Inklayer extension may start it: `cihhaaceflhcncmeoiembekghkhbgfio` in Chromium browsers, `inklayer-extension@inklayer` in Firefox. A fork with other IDs can set `INKLAYER_EXTENSION_ID` and `INKLAYER_FIREFOX_ID` when installing.

Run it again after moving Node or Claude Code. Then turn the button on from the extension popup: open **Settings** and click **Improve comments with Claude**.

To remove it:

```sh
node claude-plugin/improve/install.cjs --uninstall
```

(Uninstalling the plugin doesn't remove the helper; run this too.)

On Windows, the helper starts `claude.cmd` through `cmd.exe`, with the system prompt in a file rather than on the command line.

## What it runs

The browser starts the helper once for each request. It reads one message and answers one:

- `ping` runs `claude --version`, to check Claude Code is there.
- `improve` runs `claude -p --model haiku` with a fixed system prompt (`--system-prompt-file`), in an empty temporary folder. It runs with no tools (`--tools ""`), no MCP servers (`--strict-mcp-config`), no settings or CLAUDE.md files (`--setting-sources ""`), and no saved session. The draft, the page address and the commented element's selector and text go in as data. It gives up after 60 seconds.

Claude Code takes a few seconds to start, so a rewrite usually takes 5 to 10 seconds.

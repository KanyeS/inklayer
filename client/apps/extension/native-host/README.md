# Inklayer's local Claude helper

This is what makes the **Improve** button in the comment box work. It is a [native messaging host](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): a small program the browser starts when the extension asks it to. It passes the comment draft to the [Claude Code](https://claude.com/claude-code) CLI on this computer and returns the rewrite. The rewrite uses your own Claude Code sign-in and plan. Nothing goes to the Inklayer server until you save the comment.

## Install

Install Claude Code and sign in first. Then run this from the repository:

```sh
node client/apps/extension/native-host/install.mjs
```

The install script does three things:

- It copies `inklayer-claude-host.mjs` to `~/.local/share/inklayer/` on Linux, or `~/Library/Application Support/InkLayer/` on macOS.
- It writes a `claude-host` wrapper next to it. Browsers start helpers with a minimal `PATH`, so the wrapper records where `node` and `claude` are.
- It registers `com.inklayer.claude` in the `NativeMessagingHosts` folder of each installed Chromium browser (Chrome, Chromium, Brave, Edge). Only the Inklayer extension (`cihhaaceflhcncmeoiembekghkhbgfio`) may start it. A fork with a different ID can set `INKLAYER_EXTENSION_ID` when installing.

Run it again after moving Node or Claude Code. Then turn the button on from the extension popup: open **Settings** and click **Improve comments with Claude**.

To remove it:

```sh
node client/apps/extension/native-host/install.mjs --uninstall
```

Firefox and Windows aren't supported yet.

## What it runs

The browser starts the helper once for each request. It reads one message and answers one:

- `ping` runs `claude --version`, to check Claude Code is there.
- `improve` runs `claude -p --model haiku` with a fixed system prompt, in an empty temporary folder. It runs with no tools (`--tools ""`), no MCP servers (`--strict-mcp-config`), no settings or CLAUDE.md files (`--setting-sources ""`), and no saved session. The draft, the page address and the commented element's selector and text go in as data. It gives up after 60 seconds.

Claude Code takes a few seconds to start, so a rewrite usually takes 5 to 10 seconds.

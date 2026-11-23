# Inklayer's Claude Code plugin

One install for everything Claude does with Inklayer on your computer:

- **Improve:** the extension's Improve button rewrites comment drafts with your own Claude Code. The plugin's hook sets up the [local helper](improve/README.md) each time Claude Code starts, so it stays up to date.
- **Reviews:** the [review helper](../client/apps/review/README.md) is an MCP server that lets Claude try pages in a browser and leave Inklayer comments on them, with screenshots, page details and recordings. The `review-feature` skill tells Claude how to review.

## Install

You need Claude Code (signed in) and Node.js.

```sh
claude plugin marketplace add KanyeS/inklayer
claude plugin install inklayer@inklayer --config server_url=https://<your server>
npx -y playwright-core@1.65.1 install chromium   # once: the browser the review helper drives
```

Then restart Claude Code. The extension's popup (Settings → Improve comments with Claude) and the viewer's Connected apps section show the command with your server filled in.

Updates come with each commit to the repository: `claude plugin update inklayer@inklayer`, or let Claude Code update its plugins.

## What's in it

| Path | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | The plugin, and its one setting: your Inklayer server's address. |
| `hooks/hooks.json` | Runs `improve/install.cjs --quiet` as each session starts. |
| `improve/` | The Improve helper and its installer. |
| `.mcp.json`, `review/` | The review helper: built from `client/apps/review` and committed, with its one dependency (`playwright-core`), which Claude Code installs with the plugin. |
| `skills/review-feature/` | How Claude reviews a feature and comments on it. |

The marketplace that lists it is `.claude-plugin/marketplace.json` at the repository's root.

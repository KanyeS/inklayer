# Inklayer review helper

An MCP server that Claude Code runs on your computer. It lets Claude try web pages in a real browser and leave Inklayer comments on them, as you. Each comment is anchored to an element the same way the extension anchors it, and comes with:
- a screenshot around the element;
- the page's details: browser, window size, the element's HTML, and recent console errors and failed requests;
- optionally, a recording of the steps.

It uses Playwright's Chromium, and runs on Claude Code's own plan.

## Set up

From `client/`, after `pnpm install`:

```sh
pnpm --filter @inklayer/review build
npx playwright-core@1.65.1 install chromium   # once, if Playwright's Chromium isn't installed yet
claude mcp add inklayer-review -e INKLAYER_SERVER=https://<your server> -- node "$PWD/apps/review/dist/server.mjs"
```

To watch the browser while Claude works, add `-e INKLAYER_REVIEW_SHOW=1`.

## Signing in

The first time Claude comments, your browser opens Inklayer's sign-in page. Sign in, and allow **Inklayer review helper (Claude Code)**. You're only asked once.
- **Your account:** comments are posted as whoever signs in. To keep Claude's comments apart from your own, sign in with a separate account.
- **Tokens:** they're kept in `~/.config/inklayer/review.json`, which only you can read, and are refreshed as needed.
- **Disconnecting:** the helper is listed under **Connected apps** on Inklayer's home page. Disconnecting it revokes its tokens.

The server knows this app as the built-in client `inklayer-review`. It signs in to `http://127.0.0.1` on port 47821, 47822 or 47823 (whichever is free), the only addresses the server allows for it. Unlike apps that register themselves, its tokens work on Inklayer's API, which it needs to create comments and upload screenshots and videos.

## Tools

| Tool | What it does |
| --- | --- |
| `list_projects` | Projects you can see, and whether you can comment in them. |
| `open_page` | Opens a page (1280×800 by default) and returns a screenshot. |
| `page_outline` | The page's accessibility tree as text, for finding elements. |
| `screenshot` | The window, or the whole page. |
| `click`, `fill`, `press`, `scroll` | Interact with the page. Selectors are Playwright's: CSS, `text=Save`, `role=button[name="Save"]`. |
| `start_recording`, `stop_recording` | Record the tab. Starting reloads the page and keeps you signed in. The next comment gets the video. |
| `comment` | Comments on an element, with a screenshot, the page's details and the last recording. Use `mark: "pin"` for a pin instead of an outline. |
| `close_browser` | Closes the browser. |

To reply to, resolve or read comments, use Inklayer's own MCP server (`/api/mcp`).

## How it's built

- [src/main.ts](src/main.ts): the entry point.
- [src/mcp.ts](src/mcp.ts): the MCP protocol over stdio, kept small instead of using the SDK.
- [src/auth.ts](src/auth.ts): signing in with OAuth and PKCE through a loopback redirect.
- [src/browser.ts](src/browser.ts): the Playwright session.
- [src/comment.ts](src/comment.ts): what's sent to the API.
- [src/page/](src/page/): the script put into every page. It uses `@inklayer/overlay` to describe elements as the extension does.

Two builds go to `dist/`:
- `page.js`, a self-contained script that runs in the page;
- `server.mjs`, the server, which runs in Node.

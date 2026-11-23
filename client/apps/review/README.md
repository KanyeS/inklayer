# Inklayer review helper

An MCP server that Claude Code runs on your computer. It lets Claude try web pages in a real browser and leave Inklayer comments on them, as you. Each comment is anchored to an element the same way the extension anchors it, and comes with:

- a screenshot around the element;
- the page's details: browser, window size, the element's HTML, and recent console errors and failed requests;
- optionally, a recording of the steps.

It uses Playwright's Chromium, and runs on Claude Code's own plan.

## Set up

Install Inklayer's Claude Code plugin ([claude-plugin](../../../claude-plugin/README.md)), which runs this helper, then restart Claude Code:

```sh
claude plugin marketplace add KanyeS/inklayer && claude plugin install inklayer@inklayer --config server_url=https://<your server>
npx -y playwright-core@1.65.1 install chromium   # once: the browser it drives
```

To change the server later, use `/plugin configure inklayer@inklayer` in Claude Code.

To watch the browser while Claude works, set `INKLAYER_REVIEW_SHOW=1` in the environment Claude Code starts in.

## Sites that need a login

The review browser keeps sign-ins to the sites it reviews in `~/.config/inklayer/review-sites.json`, which only you can read. When a page needs a login, Claude uses `sign_in_to_site`:

1. A browser window opens at the site.
2. You sign in yourself, then close the window.
3. Claude carries on signed in, in this session and later ones.

Claude never sees your password.

- **To forget the sign-ins:** ask Claude to forget them (`forget_site_logins`), or delete the file.
- **To keep none at all:** set `INKLAYER_REVIEW_LOGINS=none` in the environment Claude Code starts in.
- **To keep them somewhere else:** set `INKLAYER_REVIEW_LOGINS` to another path.

The file holds the sites' session cookies, so treat it like a password. Consider a test account for sites where Claude shouldn't act as you.

## Signing in

The first time Claude comments, your browser opens Inklayer's sign-in page. Sign in, and allow **Inklayer review helper (Claude Code)**. You're only asked once.

- **Your account:** comments are posted as whoever signs in. To keep Claude's comments apart from your own, sign in with a separate account.
- **Tokens:** they're kept in `~/.config/inklayer/review.json`, which only you can read, and are refreshed as needed.
- **Disconnecting:** the helper is listed under **Connected apps** on Inklayer's home page. Disconnecting it revokes its tokens.

The server knows this app as the built-in client `inklayer-review`. It signs in to `http://127.0.0.1` on port 47821, 47822 or 47823 (whichever is free), the only addresses the server allows for it. Unlike apps that register themselves, its tokens work on Inklayer's API, which it needs to create comments and upload screenshots and videos.

## Tools

| Tool                                    | What it does                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects`                         | Projects you can see, and whether you can comment in them.                                                                                                                      |
| `open_page`                             | Opens a page (1280×800 by default) and returns a screenshot.                                                                                                                    |
| `page_outline`                          | The page's accessibility tree as text, for finding elements.                                                                                                                    |
| `screenshot`                            | The window, or the whole page.                                                                                                                                                  |
| `click`, `fill`, `press`, `scroll`      | Interact with the page. Selectors are Playwright's: CSS, `text=Save`, `role=button[name="Save"]`.                                                                               |
| `sign_in_to_site`, `forget_site_logins` | Sign in to the site under review in a window of its own, or forget the kept sign-ins.                                                                                           |
| `start_recording`, `stop_recording`     | Record the tab. Starting reloads the page and keeps you signed in. Clicks show as rings in the video, and it stops by itself after 60 seconds. The next comment gets the video. |
| `comment`                               | Comments on an element, with a screenshot, the page's details and the last recording. Use `mark: "pin"` for a pin instead of an outline.                                        |
| `close_browser`                         | Closes the browser.                                                                                                                                                             |

To reply to, resolve or read comments, use Inklayer's own MCP server (`/api/mcp`).

## How it's built

- [src/main.ts](src/main.ts): the entry point.
- [src/mcp.ts](src/mcp.ts): the MCP protocol over stdio, kept small instead of using the SDK.
- [src/auth.ts](src/auth.ts): signing in with OAuth and PKCE through a loopback redirect.
- [src/browser.ts](src/browser.ts): the Playwright session.
- [src/comment.ts](src/comment.ts): what's sent to the API.
- [src/page/](src/page/): the script put into every page. It uses `@inklayer/overlay` to describe elements as the extension does.

Two builds go to the plugin, in `claude-plugin/review/`:

- `page.js`, a self-contained script that runs in the page;
- `server.mjs`, the server, which runs in Node.

## Developing it

From `client/`, `pnpm --filter @inklayer/review build` builds the helper into the plugin (`claude-plugin/review/`), and the built files are committed, because people install the plugin straight from GitHub. A test (`client/test/claude-plugin.test.ts`) fails if they're out of date. To try a build without the plugin:

```sh
claude mcp add inklayer-review-dev -e INKLAYER_SERVER=https://<your server> -- node "$PWD/../claude-plugin/review/server.mjs"
```

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Api } from "./api";
import { Auth } from "./auth";
import { ReviewBrowser } from "./browser";
import { McpServer } from "./mcp";
import { INSTRUCTIONS, reviewTools } from "./tools";

// Inklayer's review helper: an MCP server Claude Code starts on this computer (see README.md).
//   INKLAYER_SERVER       the Inklayer server, e.g. https://inklayer.example.com (or --server <url>)
//   INKLAYER_REVIEW_SHOW    1 to show the browser window instead of running it headless
//   INKLAYER_REVIEW_LOGINS  where sign-ins to reviewed sites are kept (default ~/.config/inklayer/review-sites.json);
//                           "none" to keep none

const flag = process.argv.indexOf("--server");
const serverUrl = (flag >= 0 ? process.argv[flag + 1] : undefined) ?? process.env.INKLAYER_SERVER;
if (!serverUrl?.trim()) {
  process.stderr.write(
    "Set INKLAYER_SERVER (or pass --server <url>) to your Inklayer server's address. From the Claude Code plugin: /plugin configure inklayer@inklayer\n",
  );
  process.exit(1);
}

const api = new Api(new Auth({ serverUrl }));
const browser = new ReviewBrowser({
  pageScript: fileURLToPath(new URL("./page.js", import.meta.url)),
  headless: process.env.INKLAYER_REVIEW_SHOW !== "1",
  siteLogins: siteLogins(),
});
const server = new McpServer({ name: "inklayer-review", version: "0.1.0" }, INSTRUCTIONS, reviewTools(api, browser));

await server.serve();
await browser.close();

function siteLogins(): string | null {
  const set = process.env.INKLAYER_REVIEW_LOGINS;
  if (set === "none") return null;
  return set || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "inklayer", "review-sites.json");
}

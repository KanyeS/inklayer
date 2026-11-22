import { fileURLToPath } from "node:url";
import { Api } from "./api";
import { Auth } from "./auth";
import { ReviewBrowser } from "./browser";
import { McpServer } from "./mcp";
import { INSTRUCTIONS, reviewTools } from "./tools";

// Inklayer's review helper: an MCP server Claude Code starts on this computer (see README.md).
//   INKLAYER_SERVER       the Inklayer server, e.g. https://inklayer.example.com (or --server <url>)
//   INKLAYER_REVIEW_SHOW  1 to show the browser window instead of running it headless

const flag = process.argv.indexOf("--server");
const serverUrl = (flag >= 0 ? process.argv[flag + 1] : undefined) ?? process.env.INKLAYER_SERVER;
if (!serverUrl) {
  process.stderr.write("Set INKLAYER_SERVER (or pass --server <url>) to your Inklayer server's address.\n");
  process.exit(1);
}

const api = new Api(new Auth({ serverUrl }));
const browser = new ReviewBrowser({
  pageScript: fileURLToPath(new URL("./page.js", import.meta.url)),
  headless: process.env.INKLAYER_REVIEW_SHOW !== "1",
});
const server = new McpServer({ name: "inklayer-review", version: "0.1.0" }, INSTRUCTIONS, reviewTools(api, browser));

await server.serve();
await browser.close();

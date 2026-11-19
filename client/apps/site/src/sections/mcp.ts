/**
 * Claude (MCP): a scripted Claude Code session that connects to Inklayer, reads the open comments and their screenshot,
 * fixes the code, then replies and resolves; the panel beside it updates as each tool call lands.
 * Tool names are the server's real ones (server/src: [McpServerTool(Name = ...)]).
 */
import { $, h } from "../lib/dom";
import { type Ctx, random, scene } from "../lib/scene";

const SERVER = "https://inklayer.your-company.com/api/mcp";

/** A terminal line made of styled pieces: [class, text]. */
type Piece = [className: string, text: string];

export function mcp(): void {
  const terminal = $("#term");
  const comments = {
    4: { item: $("#mcp-c4"), status: $("#mcp-s4"), reply: $("#mcp-r4") },
    5: { item: $("#mcp-c5"), status: $("#mcp-s5"), reply: $("#mcp-r5") },
  };

  const line = (...pieces: Piece[]) =>
    terminal.append(h("div", {}, ...pieces.map(([className, text]) => h("span", { className, textContent: text }))));
  const tool = (name: string, args: string) => line(["tool", `⏺ inklayer · ${name}`], ["dim", `(${args})`]);
  const result = (text: string) => line(["dim", `  ⎿  ${text}`]);
  /** Types a command after a prompt, with a blinking cursor. */
  const typed = async (ctx: Ctx, prompt: string, text: string) => {
    const input = h("span", { className: "usr" });
    const cursor = h("span", { className: "cur" });
    terminal.append(h("div", {}, h("span", { className: "p", textContent: `${prompt} ` }), input, cursor));
    await ctx.type(text, (s) => (input.textContent = s), random(28, 40));
    cursor.remove();
  };
  /** The comment's reply and resolved state, as the assistant's calls take effect. */
  const resolve = (n: 4 | 5, reply: string) => {
    const c = comments[n];
    c.reply.hidden = false;
    c.reply.replaceChildren(h("b", { textContent: "Michael" }), ` ${reply}`);
    c.item.classList.remove("selected");
    c.item.classList.add("resolved");
    c.status.replaceChildren(h("span", { className: "ok", textContent: "Resolved" }));
  };
  const reset = () => {
    terminal.replaceChildren();
    for (const c of Object.values(comments)) {
      c.item.classList.remove("resolved", "selected");
      c.status.replaceChildren();
      c.reply.hidden = true;
    }
  };

  scene(
    $("#mcp"),
    async (ctx) => {
      reset();
      await ctx.sleep(400);
      await typed(ctx, "$", `claude mcp add --transport http inklayer ${SERVER}`);
      await ctx.sleep(500);
      line(["okc", "Added HTTP MCP server inklayer"]);
      await ctx.sleep(500);
      await typed(ctx, "$", "claude");
      await ctx.sleep(500);
      await typed(ctx, ">", "fix the open Inklayer comments on the checkout page");
      await ctx.sleep(700);

      tool("list_open_comments", 'page: "shop.example/checkout"');
      await ctx.sleep(600);
      result("2 open: #4 Rosie “button hidden behind cookie banner”, #5 Leo “total doesn't update”");
      comments[4].item.classList.add("selected");
      await ctx.sleep(800);
      tool("get_comment_screenshot", "comment: 4");
      await ctx.sleep(600);
      result("[image 1170 × 2532, iPhone SE, Safari 17]");
      await ctx.sleep(900);
      line(["", "⏺ The banner is "], ["usr", "position: fixed"], ["", " with z-index 1000 and covers the pay button."]);
      await ctx.sleep(700);
      line(["tool", "⏺ Update"], ["dim", "(src/checkout/CookieBanner.tsx)  +3 −1"]);
      await ctx.sleep(500);
      line(["tool", "⏺ Update"], ["dim", "(src/cart/useTotals.ts)  +5 −2"]);
      await ctx.sleep(700);

      tool("reply_to_comment", 'comment: 4, "Fixed: the banner sits above the safe area…"');
      await ctx.sleep(600);
      tool("set_comment_status", 'comment: 4, status: "resolved"');
      resolve(4, "Fixed: the banner now sits above the safe area and leaves room for the pay button.");
      await ctx.sleep(700);
      comments[5].item.classList.add("selected");
      tool("reply_to_comment", 'comment: 5, "Totals now recalculate when a coupon is removed."');
      await ctx.sleep(600);
      tool("set_comment_status", 'comment: 5, status: "resolved"');
      resolve(5, "Totals now recalculate when a coupon is removed.");
      await ctx.sleep(700);
      line(["okc", "⏺ Both comments fixed, replied to and resolved."]);
      await ctx.sleep(6000);
    },
    { gap: 300, reset },
  );
}

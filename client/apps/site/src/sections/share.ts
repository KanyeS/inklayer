/** Read-only links: Leo shares the page's comments; the guest view opens and its view count ticks up. */
import { $, h, replay } from "../lib/dom";
import { LEO } from "../lib/people";
import { scene } from "../lib/scene";
import { Stage } from "../lib/stage";

const LINK = "https://inklayer.your-company.com/s/q7Zr4mX2vLp9TfK3";

export function share(): void {
  const icon = $("#share-icon");
  const slot = $("#share-slot");
  const guestUrl = $("#guest-url");
  const views = $("#views");
  const stage = new Stage($(".share-stage"));
  const leo = stage.person(LEO);

  const reset = () => {
    slot.replaceChildren();
    icon.classList.remove("on");
    guestUrl.textContent = "inklayer.your-company.com/s/…";
    views.textContent = "0 views";
  };

  scene($("#share"), async (ctx) => {
    reset();
    await ctx.sleep(500);
    await leo.moveTo(ctx, { el: icon }, 1100);
    icon.classList.add("on");
    const copy = h("span", { className: "pbtn", textContent: "Copy" });
    slot.append(h("div", { className: "shared-box" },
      h("div", { className: "row", style: { "justify-content": "space-between" } },
        h("b", { textContent: "Read-only link", style: { "font-weight": "600" } }),
        h("span", { className: "muted", textContent: "Open comments · 30 days" })),
      h("div", { className: "row" }, h("span", { className: "share-url", textContent: LINK }), copy)));
    await ctx.sleep(600);

    await leo.moveTo(ctx, { el: copy }, 700);
    replay(copy, "press");
    copy.textContent = "Copied";
    await ctx.sleep(600);
    guestUrl.textContent = LINK.replace("https://", "");
    await leo.moveTo(ctx, { el: views, x: 0.3, y: 2.2 }, 1500);
    for (let n = 1; n <= 3; n++) {
      await ctx.sleep(900);
      views.textContent = `${n} view${n > 1 ? "s" : ""}`;
    }
    await ctx.sleep(3000);
  }, { gap: 600, reset });
}

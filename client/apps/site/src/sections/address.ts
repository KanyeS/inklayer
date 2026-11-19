/**
 * Which address: the scope chooser from the panel, working. Leo flips between "every version of the page" and picking
 * query parameters; the visitor can take over by clicking anything, which stops the demo.
 */
import { $, h } from "../lib/dom";
import { LEO } from "../lib/people";
import { type Ctx, scene } from "../lib/scene";
import { Stage } from "../lib/stage";

const PAGE = "shop.example/products/trail-runner";
const PARTS = [
  { text: "colour=blue", keep: true },
  { text: "size=10", keep: false },
  { text: "utm_source=newsletter", keep: false },
  { text: "fbclid=IwAR2xZk81_qA", keep: false },
  { text: "#reviews", keep: false },
];

export function address(): void {
  const card = $(".addr");
  const bar = $("#urlbar");
  const stored = $("#stored");
  const params = $("#params");
  const exact = $<HTMLInputElement>('input[name="scope"][value="exact"]');
  const every = $<HTMLInputElement>('input[name="scope"][value="all"]');

  const boxes = PARTS.map((part) => {
    const box = h("input", { type: "checkbox", checked: part.keep });
    params.append(h("label", {}, box, part.text.length > 18 ? `${part.text.slice(0, 16)}…` : part.text));
    return box;
  });

  /** The address with dropped parts struck out, and what the server would store. */
  const render = () => {
    const kept = (i: number) => exact.checked && boxes[i]!.checked;
    params.style.opacity = exact.checked ? "1" : "0.45";
    for (const box of boxes) box.disabled = !exact.checked;

    let separator = "?";
    const pieces = PARTS.map((part, i) => {
      const isHash = part.text.startsWith("#");
      const text = isHash ? part.text : `${separator}${part.text}`;
      if (!isHash) separator = "&";
      return h("span", { className: kept(i) ? "keep" : "drop", textContent: text });
    });
    bar.replaceChildren(h("span", { className: "keep", textContent: `https://${PAGE}` }), ...pieces);

    const query = PARTS.filter((p, i) => kept(i) && !p.text.startsWith("#"))
      .map((p) => p.text)
      .join("&");
    const hash = PARTS.find((p, i) => kept(i) && p.text.startsWith("#"))?.text ?? "";
    stored.textContent = PAGE + (query ? `?${query}` : "") + hash;
  };
  render();

  const stage = new Stage(card);
  const leo = stage.person(LEO);
  const click = async (ctx: Ctx, input: HTMLInputElement) => {
    await leo.moveTo(ctx, { el: input }, 900);
    if (input.type === "radio") input.checked = true;
    else input.checked = !input.checked;
    render();
    await ctx.sleep(1300);
  };

  const demo = scene(
    $("#address"),
    async (ctx) => {
      await ctx.sleep(600);
      await click(ctx, boxes[1]!);
      await click(ctx, boxes[4]!);
      await click(ctx, every);
      await click(ctx, exact);
      await click(ctx, boxes[1]!);
      await click(ctx, boxes[4]!);
      await leo.moveTo(ctx, { el: stored, x: 0.8, y: 1.6 }, 1000);
      await ctx.sleep(2000);
    },
    { gap: 1000 },
  );

  // The visitor clicked something: it's theirs now.
  card.addEventListener("change", (e) => {
    if (e.isTrusted) {
      demo.stop();
      leo.hide();
    }
    render();
  });
}

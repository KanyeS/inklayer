/**
 * Bug context: the checkout's "Place order" button really fails (a console warning and error, and a failing request), so
 * a visitor with the extension gets genuine details in their comment. The details card shows what the extension would
 * attach, using its own helpers: the visitor's browser, OS and window, and the element's HTML with form values left out.
 */
import { $, h, replay } from "../lib/dom";
import { ROSIE } from "../lib/people";
import { scene } from "../lib/scene";
import { Stage, marks } from "../lib/stage";
import { browserOf, elementHtml, osOf } from "../../../extension/src/lib/pageDetails";

export function bugContext(): void {
  const card = $("#checkout-card");
  const button = $<HTMLButtonElement>("#place-order");
  const error = $("#order-error");
  const log = $("#log");
  const shot = $("#details-shot");
  const stage = new Stage(card, { cardsOpen: true });
  const rosie = stage.person(ROSIE);

  showEnvironment();
  addEventListener("resize", showEnvironment, { passive: true });
  $("#el-info").textContent = `form#checkout > button#place-order\n${elementHtml(button)}\n${elementHtml($("#co-card"))}`;

  const addLog = (kind: "warn" | "error" | "net", text: string) => {
    log.querySelector(".placeholder")?.remove();
    log.prepend(h("li", { className: kind }, text, h("span", { className: "live", textContent: "live" })));
    while (log.children.length > 5) log.lastElementChild!.remove();
  };

  let explained = false;
  const placeOrder = async () => {
    error.classList.remove("on");
    if (!explained) console.info("Inklayer demo: “Place order” fails on purpose, so the extension has real errors to attach to a comment.");
    explained = true;

    console.warn("[checkout] Payment intent took 3.2s, retrying (1/3)");
    addLog("warn", "warn · [checkout] Payment intent took 3.2s, retrying (1/3)");

    const started = performance.now();
    const url = new URL("api/orders", location.href);
    const status = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ total: 218 }) })
      .then((r) => r.status, () => 0);
    addLog("net", `POST ${url.pathname} → ${status || "failed"} · ${Math.round(performance.now() - started)} ms`);

    try {
      const order: { summary?: { total: number } } = {};
      void order.summary!.total;
    } catch (e) {
      console.error(e);
      addLog("error", `error · ${(e as Error).name}: ${(e as Error).message}`);
    }
    error.classList.add("on");
  };
  button.addEventListener("click", () => void placeOrder().then(() => takeScreenshot(card, shot, error)));

  scene($("#bug-context"), async (ctx) => {
    await rosie.moveTo(ctx, { el: button, x: 0.8, y: -2 }, 0);
    await rosie.moveTo(ctx, { el: button, x: 0.55, y: 0.5 }, 1300);
    await placeOrder();
    await ctx.sleep(700);
    await rosie.moveTo(ctx, { el: error, x: 0.15, y: 0.5 }, 700);
    stage.add(ROSIE, marks.pin(error, 0.15, 0.5), "Order fails every time on the new checkout. Console and network attached.");
    takeScreenshot(card, shot, error);
    await ctx.sleep(1500);
    await rosie.moveTo(ctx, { el: card, x: 0.75, y: 0.2 }, 1500);
  }, { once: true });
}

/** The visitor's real environment, as the extension would record it. */
function showEnvironment(): void {
  const rows: [string, string][] = [
    ["Browser", browserOf(navigator.userAgent)],
    ["OS", osOf(navigator.userAgent)],
    ["Window", `${innerWidth} × ${innerHeight}`],
    ["Pixel ratio", String(devicePixelRatio)],
  ];
  $("#env").replaceChildren(...rows.flatMap(([term, value]) => [h("dt", { textContent: term }), h("dd", { textContent: value })]));
}

/** A thumbnail of the area around the comment: a scaled copy of the checkout, lower half, with the comment's pin. */
function takeScreenshot(card: HTMLElement, shot: HTMLElement, error: HTMLElement): void {
  shot.querySelector(".mini")?.remove();
  const copy = $("#checkout").cloneNode(true) as HTMLElement;
  for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
  const mini = h("div", { className: "mini card checkout", style: { width: `${card.clientWidth}px` } }, copy);
  mini.setAttribute("aria-hidden", "true");
  mini.inert = true;

  const top = card.clientHeight * 0.5;
  const scale = Math.min(shot.clientWidth / card.clientWidth, shot.clientHeight / (card.clientHeight - top));
  mini.style.left = `${(shot.clientWidth - card.clientWidth * scale) / 2}px`;
  mini.style.transform = `scale(${scale}) translateY(-${top}px)`;
  const pin = h("span", { className: "shot-pin", textContent: "1", style: {
    left: `${error.offsetLeft + error.offsetWidth * 0.15}px`, top: `${error.offsetTop + error.offsetHeight * 0.5}px`, "--c": ROSIE.color,
  } });
  mini.append(pin);
  shot.prepend(mini);
  replay($(".flash", shot), "go");
}

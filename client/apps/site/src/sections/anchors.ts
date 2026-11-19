/**
 * Marks stay put: four comments on a small page whose layout keeps changing. The overlay re-finds each mark's element
 * from its anchor; the readout shows the selected comment's real anchor and how well it matched. Removing the banner
 * takes it out of the page for real, so its mark becomes orphaned and is shown where it was.
 */
import type { AnchorQuality } from "@inklayer/overlay";
import { $, h } from "../lib/dom";
import { JOHN, LEO, MICHAEL, ROSIE } from "../lib/people";
import { scene } from "../lib/scene";
import { type Comment, marks, Stage } from "../lib/stage";

const QUALITY: Record<AnchorQuality, string> = {
  exact: "found exactly",
  fallback: "found by a fallback anchor",
  orphaned: "element gone: shown where it was, flagged as moved",
};

export function anchors(): void {
  const site = $("#mini");
  const promo = $("#mini-promo");
  const promoSpot = { parent: promo.parentElement!, before: promo.nextElementSibling };
  const readout = $("#anchor-readout");
  const layoutButton = $("#relayout");
  const bannerButton = $("#remove-promo");

  let quality: Record<string, AnchorQuality> = {};
  let shown: Comment | null = null;
  const stage = new Stage($(".anchor-stage"), {
    onAnchors: (q) => {
      quality = q;
      showAnchor(shown);
    },
    onSelect: (id) => showAnchor(stage.comments.find((c) => c.id === id) ?? null),
  });

  /** The selected comment's anchor, as saved: what the overlay uses to find its element again. */
  const showAnchor = (c: Comment | null) => {
    shown = c;
    if (!c) return readout.replaceChildren();
    const { path, xpath, text, box } = c.anchor.element;
    const row = (term: string, value: string) => [
      h("dt", { textContent: term }),
      h("dd", { textContent: value, title: value }),
    ];
    readout.replaceChildren(
      ...row("css", path.join(" ⟩ ")),
      ...row("xpath", xpath ?? "none"),
      ...row(
        "text",
        c.anchor.text ? `“${c.anchor.text.exact}”` : `“${text.slice(0, 40)}${text.length > 40 ? "…" : ""}”`,
      ),
      ...row(
        "saved at",
        `${Math.round(box.x)}, ${Math.round(box.y)} · ${Math.round(box.width)}×${Math.round(box.height)} px`,
      ),
      ...row("now", QUALITY[quality[c.id] ?? "exact"]),
    );
  };
  const select = (c: Comment) => {
    stage.select(c.id);
    showAnchor(c);
  };

  const setLayout = (alternate: boolean) => {
    site.classList.toggle("alt", alternate);
    layoutButton.textContent = alternate ? "Change it back" : "Change the layout";
  };
  const setBanner = (present: boolean) => {
    if (present && !promo.isConnected) promoSpot.parent.insertBefore(promo, promoSpot.before);
    if (!present) promo.remove();
    bannerButton.textContent = present ? "Remove the banner" : "Bring the banner back";
  };
  layoutButton.addEventListener("click", () => setLayout(!site.classList.contains("alt")));
  bannerButton.addEventListener("click", () => setBanner(!promo.isConnected));

  scene(
    $("#anchors"),
    async (ctx) => {
      stage.clear();
      setLayout(false);
      setBanner(true);
      const buy = stage.add(MICHAEL, marks.pin($("#mini-buy")), "Buy buttons should say “Add to cart”.");
      await ctx.sleep(350);
      const title = stage.add(JOHN, marks.element($("#mini-h1")), "Title wraps on small cards.");
      await ctx.sleep(350);
      const banner = stage.add(
        ROSIE,
        marks.rect(promo, { x: -0.01, y: -0.12 }, { x: 1.01, y: 1.12 }),
        "Remove after Sunday.",
      );
      await ctx.sleep(350);
      const water = stage.add(
        LEO,
        marks.highlight($("#mini-p2"), "Water-resistant"),
        "Not waterproof? Check with the supplier.",
      );

      select(buy);
      await ctx.sleep(1800);
      setLayout(true);
      await ctx.sleep(2200);
      select(title);
      await ctx.sleep(1600);
      setLayout(false);
      await ctx.sleep(1800);
      select(water);
      await ctx.sleep(1200);
      setLayout(true);
      await ctx.sleep(1800);
      select(banner);
      await ctx.sleep(900);
      setBanner(false);
      await ctx.sleep(3200);
      setLayout(false);
      await ctx.sleep(2400);
      setBanner(true);
      await ctx.sleep(1800);
    },
    { gap: 300 },
  );
}

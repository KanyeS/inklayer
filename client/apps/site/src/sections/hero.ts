/** Hero: the whole team reviewing a sale page at once. Each leaves a comment; cards open beside the marks. */
import { $ } from "../lib/dom";
import { JOHN, LEO, MICHAEL, ROSIE } from "../lib/people";
import { scene, together } from "../lib/scene";
import { marks, Stage } from "../lib/stage";

export function hero(): void {
  const stage = new Stage($("#hero-page"), { avatars: true });
  const john = stage.person(JOHN);
  const michael = stage.person(MICHAEL);
  const rosie = stage.person(ROSIE);
  const leo = stage.person(LEO);
  const badge = $("#hero-badge");
  const count = () => {
    badge.textContent = String(stage.comments.length);
    badge.hidden = stage.comments.length === 0;
  };
  const el = {
    title: $("#hero-h3"),
    text: $("#hero-p"),
    button: $("#hero-btn"),
    photo: $("#hero-shot"),
    card1: $("#hero-c1"),
    card3: $("#hero-c3"),
  };
  count();

  scene(
    $("#hero"),
    async (ctx) => {
      await together(
        (async () => {
          await leo.select(ctx, el.title, "Summer sale", 700);
          await ctx.sleep(2200);
          leo.clearSelection();
          await leo.moveTo(ctx, { el: el.card3, x: 0.6, y: 0.5 }, 1500);
        })(),
        (async () => {
          await ctx.sleep(700);
          await michael.moveTo(ctx, { el: el.button, x: 0.75, y: 0.55 }, 1400);
          const c = stage.add(MICHAEL, marks.pin(el.button, 0.75, 0.55), "Can this say “Shop the sale →”?");
          stage.pinCard(c.id);
          count();
          await michael.moveTo(ctx, { el: el.card1, x: 0.5, y: 0.4 }, 1300);
        })(),
        (async () => {
          await ctx.sleep(1600);
          const from = { x: -0.05, y: -0.06 };
          const c = stage.add(
            ROSIE,
            marks.rect(el.photo, from, from),
            "Hero image is soft on retina. Export it at 2x.",
            { draft: true },
          );
          await rosie.drag(ctx, el.photo, from, { x: 1.05, y: 1.06 }, (to) =>
            stage.update(c, { geometry: { kind: "Rect", from, to } }),
          );
          stage.update(c, { draft: false });
          count();
          await rosie.moveTo(ctx, { el: el.text, x: 0.85, y: 1.8 }, 1200);
        })(),
        (async () => {
          await ctx.sleep(2900);
          await john.select(ctx, el.text, "40% off", 500);
          john.clearSelection();
          stage.add(JOHN, marks.highlight(el.text, "40% off"), "Should read “up to 40% off” everywhere.");
          count();
          await john.moveTo(ctx, { el: el.title, x: 1.05, y: 0.3 }, 1500);
        })(),
      );
      await ctx.sleep(5000);
    },
    {
      gap: 600,
      reset: () => {
        stage.clear();
        count();
      },
    },
  );
}

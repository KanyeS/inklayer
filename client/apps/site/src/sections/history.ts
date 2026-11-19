/**
 * History and activity: a comment's revisions appear one by one; then Leo and John edit it at the same time, and the
 * second save is refused instead of overwriting the first.
 */
import { $, h } from "../lib/dom";
import { JOHN, LEO, MICHAEL, ROSIE, type Person } from "../lib/people";
import { scene, together } from "../lib/scene";

type Diff = (Node | string)[];
const del = (text: string) => h("del", { textContent: text });
const ins = (text: string) => h("ins", { textContent: text });

const REVISIONS: [Person, string, string, Diff?][] = [
  [ROSIE, "09:58", "commented", ["Checkout button hidden on iPhone"]],
  [ROSIE, "10:03", "edited", ["Checkout button ", del("hidden"), " ", ins("is hidden behind the cookie banner"), " on iPhone", ins(" SE")]],
  [MICHAEL, "11:20", "created GitHub issue #482"],
  [MICHAEL, "14:02", "resolved"],
  [ROSIE, "14:30", "reopened", ["Still happens in landscape."]],
  [MICHAEL, "15:05", "resolved"],
];

const ACTIVITY: [Person, string, string, string][] = [
  [MICHAEL, "resolved #4", "/checkout", "2m"],
  [ROSIE, "reopened #4", "/checkout", "37m"],
  [JOHN, "commented #1", "/summer-sale", "1h"],
  [LEO, "edited #2", "/summer-sale", "2h"],
];

const TEXT = "Checkout button is hidden behind the cookie banner on iPhone SE.";

export function history(): void {
  const timeline = $("#timeline");
  const activity = $("#activity");
  const editors = {
    leo: { text: $("#ed-leo"), result: $("#res-leo") },
    john: { text: $("#ed-john"), result: $("#res-john") },
  };

  const face = (p: Person) => h("span", { className: "face", style: { "--c": p.color }, textContent: p.name[0]! });
  const revision = (p: Person, time: string, what: string, diff?: Diff) => h("li", {},
    face(p),
    h("div", { className: "what" }, h("b", { textContent: p.name }), ` ${what} `, h("time", { textContent: time })),
    diff && h("div", { className: "diff" }, ...diff));
  const event = (p: Person, what: string, where: string, time: string) => h("li", {},
    face(p),
    h("span", {}, h("b", { textContent: p.name }), ` ${what} `, h("span", { className: "where", textContent: where })),
    h("time", { textContent: time }));
  const result = (el: HTMLElement, ok: boolean, text: string) => {
    el.className = `res ${ok ? "ok" : "no"}`;
    el.textContent = text;
  };

  const reset = () => {
    timeline.replaceChildren();
    activity.replaceChildren(...ACTIVITY.map((a) => event(...a)));
    for (const editor of Object.values(editors)) {
      editor.text.textContent = TEXT;
      editor.result.className = "res";
    }
  };
  reset();

  scene($("#history"), async (ctx) => {
    reset();
    for (const r of REVISIONS) {
      timeline.append(revision(...r));
      await ctx.sleep(700);
    }

    // Both start from the same version and type at once.
    await ctx.sleep(400);
    await together(
      ctx.type(" Also on Pixel 4a.", (s) => (editors.leo.text.textContent = TEXT + s), 18),
      ctx.sleep(400).then(() => ctx.type(" Blocks release.", (s) => (editors.john.text.textContent = TEXT + s), 16)),
    );
    await ctx.sleep(400);
    result(editors.leo.result, true, "Saved as revision 7.");
    timeline.append(revision(LEO, "15:41", "edited", ["on iPhone SE.", ins(" Also on Pixel 4a.")]));
    activity.prepend(event(LEO, "edited #4", "/checkout", "now"));
    await ctx.sleep(900);
    result(editors.john.result, false, "Not saved: Leo changed this comment while you were editing. Your text is kept so you can merge it.");
    await ctx.sleep(5000);
  }, { gap: 400, reset });
}

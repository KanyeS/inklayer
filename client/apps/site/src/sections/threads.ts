/**
 * Threads, mentions, notifications: Leo replies to Rosie's comment and mentions Michael (picked from the suggestions);
 * Michael is notified, replies, and the thread's people are notified in turn.
 */
import { $, h, replay } from "../lib/dom";
import { LEO, MICHAEL, type Person } from "../lib/people";
import { scene } from "../lib/scene";
import { Stage } from "../lib/stage";

export function threads(): void {
  const panel = $("#thread-panel");
  const compose = $("#thread-ta");
  const replies = $("#thread-replies");
  const send = $("#thread-send");
  const bell = $("#bell");
  const toasts = $("#toasts");
  const firstToasts = [...toasts.children];

  const stage = new Stage(panel);
  const leo = stage.person(LEO);

  /** A notification card, newest first, two at most. */
  const notify = (from: Person, ...message: (Node | string)[]) => {
    toasts.prepend(h("div", { className: "card toast new" },
      h("span", { className: "face", style: { "--c": from.color }, textContent: from.name[0]! }),
      h("div", {}, ...message),
      h("time", { textContent: "now" })));
    while (toasts.children.length > 2) toasts.lastElementChild!.remove();
  };
  const reply = (person: Person, ...body: (Node | string)[]) => replies.append(h("div", {}, h("b", { textContent: person.name }), " ", ...body));
  const mention = (person: Person) => h("span", { className: "mention", textContent: `@${person.name}` });

  const reset = () => {
    replies.replaceChildren();
    compose.replaceChildren();
    bell.classList.remove("on");
    bell.querySelector(".bb")?.remove();
    toasts.replaceChildren(...firstToasts);
  };

  scene($("#threads"), async (ctx) => {
    reset();
    await leo.moveTo(ctx, { el: compose, x: 0.3 }, 1000);
    compose.classList.add("typing");

    // Typing "@Mi" brings up suggestions; picking one turns it into a mention.
    const typed = document.createTextNode("");
    compose.append(typed);
    await ctx.type("Thanks Rosie. @Mi", (s) => (typed.data = s));
    const suggestions = h("div", { className: "mention-pop" },
      h("div", { className: "on" }, h("span", { className: "face", style: { "--c": MICHAEL.color }, textContent: "M" }), "Michael", h("small", { textContent: "Dev" })),
      h("div", {}, h("span", { className: "face", style: { "--c": "#8b5cf6" }, textContent: "M" }), "Mia Alvarez", h("small", { textContent: "Marketing" })));
    suggestions.style.left = `${compose.offsetLeft + 10}px`;
    suggestions.style.top = `${compose.offsetTop + compose.offsetHeight + 2}px`;
    panel.append(suggestions);
    await ctx.sleep(500);
    await leo.moveTo(ctx, { el: suggestions.firstElementChild!, x: 0.4 }, 600);
    suggestions.remove();
    typed.data = "Thanks Rosie. ";
    compose.append(mention(MICHAEL));
    const rest = document.createTextNode("");
    compose.append(rest);
    const text = " can you take this one? Looks like a z-index fight with the banner.";
    await ctx.type(text, (s) => (rest.data = s));
    compose.classList.remove("typing");

    await leo.moveTo(ctx, { el: send }, 700);
    replay(send, "press");
    reply(LEO, "Thanks Rosie. ", mention(MICHAEL), text);
    compose.replaceChildren();
    await ctx.sleep(500);
    notify(LEO, h("b", { textContent: "Leo" }), " mentioned you: “can you take this one?”", h("p", { textContent: "shop.example/checkout · to Michael" }));

    await leo.moveTo(ctx, { el: panel, x: 0.75, y: 0.1 }, 1200);
    await ctx.sleep(1800);
    reply(MICHAEL, "On it. The banner is fixed with z-index 1000.");
    bell.classList.add("on");
    bell.append(h("span", { className: "bb", textContent: "1" }));
    notify(MICHAEL, h("b", { textContent: "Michael" }), " replied in a thread you're in", h("p", { textContent: "shop.example/checkout · to Leo and Rosie" }));
    await ctx.sleep(4000);
  }, { reset, gap: 800 });
}

/**
 * Tools: the team demos each tool on a shop page, with every comment's card open beside its mark. Clicking a tool in the
 * panel stops the demo and hands the visitor the real tools (Overlay's own pin, element, highlight, box, arrow and ink).
 */
import type { Draft, Point, Tool } from "@inklayer/overlay";
import { $, $$, h } from "../lib/dom";
import { JOHN, LEO, MICHAEL, ROSIE, YOU, type Person } from "../lib/people";
import { type Ctx, scene } from "../lib/scene";
import { type Comment, type Cursor, type Mark, Stage, marks } from "../lib/stage";

const HINTS: Record<Tool, string> = {
  select: "Click a mark to find its comment.",
  pin: "Click to pin a comment to a point.",
  element: "Click an element to outline it.",
  highlight: "Select text to highlight it.",
  rect: "Drag to draw a box.",
  arrow: "Drag to draw an arrow.",
  ink: "Draw freehand. Pen pressure works too.",
};

export function tools(): void {
  const panel = {
    chips: $$<HTMLButtonElement>("#tool-chips .tool"),
    swatches: $$("#tool-colors .swatch"),
    hint: $("#tool-hint"),
    driving: $("#driving"),
    draft: $("#tool-draft"),
    text: $<HTMLTextAreaElement>("#tool-ta"),
    save: $<HTMLButtonElement>("#tool-save"),
    cancel: $<HTMLButtonElement>("#tool-cancel"),
    list: $("#tool-list"),
    cardsToggle: $<HTMLButtonElement>("#cards-toggle"),
  };
  const page = {
    shop: $("#shop"), price: $("#shop-price"), cart: $("#shop-cart"), sizes: $("#shop-sizes"), photo: $("#shop-photo"),
    stars: $("#shop-stars"), description: $("#shop-desc"),
  };

  let pending: Draft | null = null;
  const stage = new Stage(page.shop, {
    cardsOpen: true,
    onDraft: (draft) => {
      pending = draft;
      panel.draft.hidden = false;
      panel.text.value = "";
      panel.text.focus({ preventScroll: true });
    },
    onSelect: (id) => showSelected(id),
  });

  /* ---------------------------------------------------------------- the panel */

  const chip = (tool: Tool) => panel.chips.find((c) => c.dataset.tool === tool)!;
  const setTool = (tool: Tool, color: string) => {
    for (const c of panel.chips) c.classList.toggle("active", c.dataset.tool === tool);
    for (const s of panel.swatches) s.classList.toggle("active", s.style.getPropertyValue("--c").trim() === color);
    panel.hint.textContent = HINTS[tool];
  };
  const addToList = (c: Comment) => {
    const item = h("li", { className: "item" },
      h("div", { className: "meta" },
        h("span", { className: "badge", style: { "--c": c.person.color }, textContent: String(c.label) }),
        h("b", { textContent: c.person.name }),
        h("span", { textContent: `· ${c.time}` })),
      h("p", { className: "body", textContent: c.body }));
    item.dataset.id = c.id;
    item.addEventListener("click", () => {
      stage.select(c.id);
      showSelected(c.id);
    });
    panel.list.append(item);
    panel.list.scrollTop = panel.list.scrollHeight;
  };
  const showSelected = (id: string | null) => {
    for (const item of $$(".item", panel.list)) item.classList.toggle("selected", item.dataset.id === id);
  };
  const reset = () => {
    stage.clear();
    panel.list.replaceChildren();
    panel.draft.hidden = true;
    panel.text.value = "";
    setTool("select", JOHN.color);
  };

  panel.cardsToggle.addEventListener("click", () => {
    stage.setCardsOpen(!stage.cardsOpen);
    panel.cardsToggle.classList.toggle("on", stage.cardsOpen);
    panel.cardsToggle.setAttribute("aria-pressed", String(stage.cardsOpen));
  });

  /* ---------------------------------------------------------------- the demo */

  /** One teammate using one tool: pick it in the panel, mark the page, write the comment, save. */
  const demo = async (ctx: Ctx, cursor: Cursor, tool: Tool, comment: string, draw: (person: Person) => Promise<Comment>) => {
    const person = cursor.person;
    await cursor.moveTo(ctx, { el: chip(tool) }, 900);
    setTool(tool, person.color);
    const c = await draw(person);
    panel.draft.hidden = false;
    await ctx.type(comment, (soFar) => (panel.text.value = soFar), 34);
    await cursor.moveTo(ctx, { el: panel.save }, 700);
    panel.draft.hidden = true;
    panel.text.value = "";
    stage.update(c, { body: comment, draft: false });
    addToList(c);
    setTool("select", person.color);
    await ctx.sleep(500);
  };

  const rosie = stage.person(ROSIE);
  const john = stage.person(JOHN);
  const leo = stage.person(LEO);
  const michael = stage.person(MICHAEL);
  const draft = (person: Person, mark: Mark) => stage.add(person, mark, "", { draft: true });

  const demoScene = scene($("#tools"), async (ctx) => {
    reset();
    await demo(ctx, rosie, "pin", "Show the sale price in red, like the card on the home page.", async (person) => {
      await rosie.moveTo(ctx, { el: page.price, x: 0.22, y: 0.45 }, 1000);
      return draft(person, marks.pin(page.price, 0.22, 0.45));
    });
    await demo(ctx, john, "element", "Make this full width on mobile.", async (person) => {
      await john.moveTo(ctx, { el: page.cart, x: 0.6, y: 0.5 }, 1000);
      return draft(person, marks.element(page.cart));
    });
    await demo(ctx, leo, "highlight", "Is this still right for orders to Australia?", async (person) => {
      await leo.select(ctx, page.description, "ships in 3–5 days", 800);
      leo.clearSelection();
      return draft(person, marks.highlight(page.description, "ships in 3–5 days"));
    });
    await demo(ctx, michael, "rect", "Size 11 wraps onto two lines in Safari.", async (person) => {
      const from = { x: -0.03, y: -0.2 };
      const c = draft(person, marks.rect(page.sizes, from, from));
      await michael.drag(ctx, page.sizes, from, { x: 1.03, y: 1.2 }, (to) => stage.update(c, { geometry: { kind: "Rect", from, to } }), 900);
      return c;
    });
    await demo(ctx, john, "arrow", "Swap in the new colourway photo here.", async (person) => {
      const from = { x: 1.25, y: 1.15 };
      const c = draft(person, marks.arrow(page.photo, from, from));
      await john.drag(ctx, page.photo, from, { x: 0.8, y: 0.8 }, (to) => stage.update(c, { geometry: { kind: "Arrow", from, to } }), 700);
      return c;
    });
    await demo(ctx, rosie, "ink", "The stars sit 2px lower than the review count.", async (person) => {
      const loop = circle(46);
      const c = draft(person, marks.ink(page.stars, loop.slice(0, 1)));
      await rosie.trace(ctx, page.stars, loop, (soFar) => stage.update(c, { geometry: marks.ink(page.stars, soFar).geometry }));
      return c;
    });

    // Select: clicking a comment in the list finds its mark.
    for (const c of [stage.comments[1]!, stage.comments[4]!]) {
      await michael.moveTo(ctx, { el: $(`[data-id="${c.id}"]`, panel.list), x: 0.4 }, 900);
      stage.select(c.id);
      showSelected(c.id);
      await ctx.sleep(1500);
    }
    await ctx.sleep(2500);
  }, { reset, gap: 400 });

  /* ---------------------------------------------------------------- the visitor tries it */

  let color = YOU.color;
  let current: Tool = "select";
  let trying = false;
  const tryTool = (tool: Tool) => {
    current = tool;
    if (!trying) {
      trying = true;
      demoScene.stop();
      for (const cursor of [rosie, john, leo, michael]) cursor.hide();
      reset();
      panel.driving.hidden = false;
    }
    stage.setTool(tool, color);
    setTool(tool, color);
  };
  for (const c of panel.chips) c.addEventListener("click", () => tryTool(c.dataset.tool as Tool));
  for (const s of panel.swatches) {
    s.addEventListener("click", () => {
      color = s.style.getPropertyValue("--c").trim();
      if (trying) tryTool(current);
    });
  }
  panel.save.addEventListener("click", () => {
    if (!pending) return;
    const person = { ...YOU, color };
    const c = stage.add(person, pending, panel.text.value.trim() || "(no text)", { time: "not saved" });
    addToList(c);
    stage.clearDraft();
    pending = null;
    panel.draft.hidden = true;
    panel.text.value = "";
  });
  panel.cancel.addEventListener("click", () => {
    stage.clearDraft();
    pending = null;
    panel.draft.hidden = true;
  });
  $("#resume-demo").addEventListener("click", () => {
    trying = false;
    panel.driving.hidden = true;
    stage.setTool("select", color);
    demoScene.start();
  });
}

/** A hand-drawn loop around an element, as fractions of its box. */
function circle(steps: number): Point[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = -0.5 + (i / steps) * (Math.PI * 2 + 0.5);
    const wobble = 1 + Math.sin(i * 1.7) * 0.03;
    return { x: 0.5 + Math.cos(angle) * 0.56 * wobble, y: 0.5 + Math.sin(angle) * 0.95 * wobble };
  });
}

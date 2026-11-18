import { describe, expect, it } from "vitest";
import { BubbleLayer } from "../src/bubbles";

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

/** jsdom has no layout: give every card a height and the page a width. */
function fakeLayout(pageWidth: number, cardHeight: number) {
  Object.defineProperty(document.documentElement, "scrollWidth", { configurable: true, value: pageWidth });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => cardHeight });
}

const cards = (layer: BubbleLayer) => [...layer.root.querySelectorAll<HTMLElement>(".bubble")];
const position = (card: HTMLElement) => card.style.transform.match(/-?\d+/g)!.map(Number);

describe("comment bubbles", () => {
  it("sit beside their marks without overlapping, and flip left near the right edge", async () => {
    fakeLayout(1200, 100);
    const layer = new BubbleLayer("", () => undefined, () => undefined);
    layer.setPositions({ a: { x: 100, y: 200 }, b: { x: 110, y: 230 }, c: { x: 1100, y: 600 }, hidden: { x: 0, y: 0 } });
    layer.show(["a", "b", "c", "nowhere"], (id) => [document.createTextNode(`comment ${id}`)]);
    await frame();

    const [a, b, c] = cards(layer);
    expect(cards(layer)).toHaveLength(3); // only ids that have a mark on the page
    expect(position(a!)).toEqual([118, 184]);
    expect(position(b!)[1]).toBe(184 + 100 + 8); // pushed below a
    expect(position(c!)[0]).toBe(1100 - 18 - 300); // to the left of its mark
    expect(c!.classList.contains("left")).toBe(true);

    layer.show(["b"], (id) => [document.createTextNode(`comment ${id}`)]);
    expect(cards(layer).map((el) => el.dataset.id)).toEqual(["b"]);
    layer.destroy();
  });

  it("keeps a reply being typed when a card is rebuilt", () => {
    fakeLayout(1200, 100);
    const layer = new BubbleLayer("", () => undefined, () => undefined);
    layer.setPositions({ a: { x: 100, y: 200 } });
    const box = document.createElement("textarea");
    box.value = "half a reply";
    layer.show(["a"], () => [box]);
    box.focus();
    box.setSelectionRange(4, 4);

    layer.show(["a"], () => [document.createTextNode("updated"), box]);
    expect(layer.hasFocus("a")).toBe(true);
    expect(box.selectionStart).toBe(4);
    layer.destroy();
  });
});

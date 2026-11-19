import { afterEach, describe, expect, it } from "vitest";
import { Overlay } from "../src/overlay";
import type { OverlayMessage } from "../src/types";

/** jsdom has no layout: no ResizeObserver, and no hit-testing. */
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

/** The element "under the pointer" is whatever the test last clicked. */
let hit: Element | null = null;
document.elementsFromPoint = () => (hit ? [hit] : []);

function click(el: Element): MouseEvent {
  hit = el;
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 });
  el.dispatchEvent(event);
  return event;
}

describe("overlay within an element", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("draws inside the element and only takes tool input there", () => {
    const within = document.createElement("div");
    const inside = document.createElement("p");
    inside.textContent = "inside";
    within.append(inside);
    const outside = document.createElement("a");
    outside.textContent = "a link elsewhere on the page";
    document.body.append(within, outside);

    const messages: OverlayMessage[] = [];
    const overlay = new Overlay(document, (m) => messages.push(m), { within });
    overlay.handle({ type: "setTool", tool: "pin", color: "#ef4444" });
    expect(document.querySelector("inklayer-overlay")!.parentElement).toBe(within);

    // A click outside isn't the overlay's: it isn't swallowed and makes no draft.
    expect(click(outside).defaultPrevented).toBe(false);
    expect(messages.some((m) => m.type === "draft")).toBe(false);

    // A click inside pins a draft to the element clicked.
    expect(click(inside).defaultPrevented).toBe(true);
    const draft = messages.find((m) => m.type === "draft");
    expect(draft?.type === "draft" && draft.draft.kind).toBe("Pin");
    overlay.destroy();
  });

  it("without `within`, the whole page is the overlay's, as before", () => {
    const link = document.createElement("a");
    document.body.append(link);
    const overlay = new Overlay(document, () => undefined);
    overlay.handle({ type: "setTool", tool: "pin", color: "#ef4444" });
    expect(document.querySelector("inklayer-overlay")!.parentElement).toBe(document.documentElement);
    expect(click(link).defaultPrevented).toBe(true);
    overlay.destroy();
  });
});

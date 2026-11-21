import { afterEach, describe, expect, it, vi } from "vitest";
import { Overlay } from "../src/overlay";
import type { OverlayAnnotation, OverlayMessage } from "../src/types";

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

describe("finding marks again when the page changes", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  const mark = (id: string, path: string, tag: string, text: string): OverlayAnnotation => ({
    id,
    kind: "Element",
    color: "#ef4444",
    resolved: false,
    label: 1,
    anchor: { element: { path: [path], xpath: null, tag, text, box: { x: 0, y: 0, width: 10, height: 10 } } },
    geometry: { kind: "Element" },
  });

  it("keeps marks still in place, finds changed ones again, and looks for missing ones less and less often", () => {
    const title = document.createElement("h1");
    title.id = "title";
    title.textContent = "Alt Hits";
    document.body.append(title);
    const messages: OverlayMessage[] = [];
    const overlay = new Overlay(document, (m) => messages.push(m));
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const fuzzy = vi.spyOn(document, "getElementsByTagName");
    const quality = () => {
      const last = messages.filter((m) => m.type === "anchors").at(-1);
      return last?.type === "anchors" ? last.quality : {};
    };

    overlay.handle({
      type: "setAnnotations",
      annotations: [mark("found", "#title", "h1", "Alt Hits"), mark("gone", "#missing", "p", "Old song")],
    });
    expect(quality()).toEqual({ found: "exact", gone: "orphaned" });
    fuzzy.mockClear();

    // The page keeps changing (a music player): the found mark isn't looked for, the missing one once, then not for 2 s.
    overlay.reanchor();
    overlay.reanchor();
    expect(fuzzy).toHaveBeenCalledTimes(1);
    now = 2100;
    overlay.reanchor();
    expect(fuzzy).toHaveBeenCalledTimes(2);
    now = 3000; // next look not before 2.1 s + 4 s
    overlay.reanchor();
    expect(fuzzy).toHaveBeenCalledTimes(2);

    // The page reused the element for something else: it's looked up again, rather than kept.
    const lookups = vi.spyOn(document, "querySelector");
    overlay.reanchor();
    expect(lookups).not.toHaveBeenCalledWith("#title");
    title.textContent = "Daily Mix";
    overlay.reanchor();
    expect(lookups).toHaveBeenCalledWith("#title");
    overlay.destroy();
  });
});

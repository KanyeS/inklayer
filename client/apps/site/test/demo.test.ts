import { describe, expect, it, vi } from "vitest";
import { commentCard } from "../src/lib/cards";
import { curvedPoint } from "../src/lib/cursor";
import type { Comment } from "../src/lib/marks";
import { YOU } from "../src/lib/people";

describe("demo cursors", () => {
  it("start and end exactly where asked", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 50 };
    expect(curvedPoint(from, to, 0, 0.3)).toEqual(from);
    const end = curvedPoint(from, to, 1, 0.3);
    expect(end.x).toBeCloseTo(100);
    expect(end.y).toBeCloseTo(50);
  });

  it("bow sideways in the middle, and go straight without a bend", () => {
    const mid = curvedPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5, 0.2);
    expect(mid).toEqual({ x: 50, y: 20 });
    expect(curvedPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5, 0)).toEqual({ x: 50, y: 0 });
  });
});

describe("demo comment cards", () => {
  const comment = (overrides: Partial<Comment> = {}): Comment => ({
    id: "c1",
    label: 1,
    person: YOU,
    body: "Looks good",
    time: "2m",
    resolved: false,
    replies: [],
    draft: false,
    kind: "Pin",
    anchor: {
      element: { path: ["body"], xpath: null, tag: "body", text: "", box: { x: 0, y: 0, width: 0, height: 0 } },
    },
    geometry: { kind: "Pin", point: { x: 0, y: 0 } },
    ...overrides,
  });
  const root = (nodes: Node[]) => {
    const div = document.createElement("div");
    div.append(...nodes);
    return div;
  };

  it("shows the author, the comment and its replies", () => {
    const card = root(
      commentCard(comment({ resolved: true, replies: [{ person: YOU, body: "Thanks", time: "1m" }] }), false, vi.fn()),
    );
    expect(card.querySelector(".bubble-head strong")?.textContent).toBe(YOU.name);
    expect(card.querySelector(".bubble-head")?.textContent).toContain("· resolved");
    expect(card.querySelector(".body")?.textContent).toBe("Looks good");
    expect(card.querySelectorAll(".reply")).toHaveLength(1);
  });

  it("shows … for a comment still being written", () => {
    expect(root(commentCard(comment({ body: "" }), false, vi.fn())).querySelector(".body")?.textContent).toBe("…");
  });

  it("toggles its pin", () => {
    const onPin = vi.fn();
    const card = root(commentCard(comment(), true, onPin));
    const pin = card.querySelector<HTMLButtonElement>(".pin-toggle.on");
    expect(pin?.querySelector("svg path")).not.toBeNull();
    pin?.click();
    expect(onPin).toHaveBeenCalledWith(false);
  });
});

import { describe, expect, it } from "vitest";
import { arrowheadPoints, badgeAnchor, markShapes, svgPath } from "../src/shapes";
import { pressure, round, strokeBounds, strokeGeometry } from "../src/stroke";

const box = { x: 100, y: 200, width: 200, height: 100 };

describe("where the badge goes", () => {
  it("is a pin's point", () => {
    expect(badgeAnchor({ kind: "Pin", point: { x: 0.5, y: 0.5 } }, box)).toEqual({ x: 200, y: 250 });
  });

  it("is the top-left of a box, whichever way it was drawn", () => {
    const geometry = { kind: "Rect", from: { x: 1, y: 1 }, to: { x: 0.5, y: 0 } } as const;
    expect(badgeAnchor(geometry, box)).toEqual({ x: 200, y: 200 });
  });

  it("is where an arrow or stroke starts", () => {
    expect(badgeAnchor({ kind: "Arrow", from: { x: 0, y: 1 }, to: { x: 1, y: 0 } }, box)).toEqual({ x: 100, y: 300 });
    expect(badgeAnchor({ kind: "Ink", size: 6, points: [[0.5, 0, 0.5]] }, box)).toEqual({ x: 200, y: 200 });
  });

  it("is the first highlighted line, or the element without one", () => {
    const lines = [{ x: 120, y: 210, width: 50, height: 16 }];
    expect(badgeAnchor({ kind: "Highlight" }, box, lines)).toEqual({ x: 120, y: 210 });
    expect(badgeAnchor({ kind: "Highlight" }, box, null)).toEqual({ x: 100, y: 200 });
    expect(badgeAnchor({ kind: "Element" }, box)).toEqual({ x: 100, y: 200 });
  });
});

describe("mark shapes", () => {
  it("draws one shape per kind, and nothing for a pin", () => {
    const kinds = (geometry: Parameters<typeof markShapes>[1], lines: Parameters<typeof markShapes>[3] = null) =>
      markShapes(document, geometry, box, lines).map((el) => `${el.tagName}.${el.getAttribute("class") ?? ""}`);
    expect(kinds({ kind: "Pin", point: { x: 0, y: 0 } })).toEqual([]);
    expect(kinds({ kind: "Element" })).toEqual(["rect.outline"]);
    expect(kinds({ kind: "Rect", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })).toEqual(["rect.rect"]);
    expect(kinds({ kind: "Arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })).toEqual(["g."]);
    expect(
      kinds({
        kind: "Ink",
        size: 6,
        points: [
          [0, 0, 0.5],
          [1, 1, 0.5],
        ],
      }),
    ).toEqual(["path.ink"]);
  });

  it("highlights each line of text, or the whole element when the text wasn't found", () => {
    const lines = [box, { ...box, y: 320 }];
    expect(markShapes(document, { kind: "Highlight" }, box, lines)).toHaveLength(2);
    expect(markShapes(document, { kind: "Highlight" }, box, null)).toHaveLength(1);
    expect(markShapes(document, { kind: "Highlight" }, box, [])).toHaveLength(0);
  });

  it("points an arrowhead at the tip", () => {
    const [tip, left, right] = arrowheadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
    expect(tip).toEqual([100, 0]);
    expect(left?.[0]).toBeLessThan(100);
    expect(left?.[1]).toBeCloseTo(-(right?.[1] ?? 0));
  });

  it("turns a stroke outline into a closed path", () => {
    expect(svgPath([[0, 0]])).toBe("");
    expect(
      svgPath([
        [0, 0],
        [10, 0],
        [10, 10],
      ]),
    ).toBe("M0.0,0.0 Q0.0,0.0 5.0,0.0 10.0,0.0 10.0,5.0 10.0,10.0 5.0,5.0 Z");
  });
});

describe("finishing a stroke", () => {
  it("counts a tiny stroke as a click", () => {
    expect(strokeBounds({ tool: "rect", points: [[10, 10, 0.5]] })).toBeNull();
    expect(
      strokeBounds({
        tool: "rect",
        points: [
          [10, 10, 0.5],
          [12, 13, 0.5],
        ],
      }),
    ).toBeNull();
    expect(
      strokeBounds({
        tool: "rect",
        points: [
          [10, 10, 0.5],
          [30, 12, 0.5],
        ],
      }),
    ).toEqual({ x: 10, y: 10, width: 20, height: 2 });
  });

  it("saves boxes and arrows from where they started to where they ended, relative to the anchor", () => {
    const stroke = {
      tool: "arrow" as const,
      points: [
        [100, 200, 0.5],
        [300, 300, 0.5],
      ] as [number, number, number][],
    };
    expect(strokeGeometry(stroke, box)).toEqual({ kind: "Arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } });
    expect(strokeGeometry({ ...stroke, tool: "rect" }, box).kind).toBe("Rect");
  });

  it("saves every ink point, rounded, with its pressure", () => {
    const stroke = {
      tool: "ink" as const,
      points: [
        [100, 200, 0.333333],
        [133.33333, 250, 0.7],
      ] as [number, number, number][],
    };
    expect(strokeGeometry(stroke, box)).toEqual({
      kind: "Ink",
      size: 6,
      points: [
        [0, 0, 0.3333],
        [0.1667, 0.5, 0.7],
      ],
    });
  });

  it("uses pen pressure only from pens", () => {
    expect(pressure({ pointerType: "pen", pressure: 0.8 })).toBe(0.8);
    expect(pressure({ pointerType: "pen", pressure: 0 })).toBe(0.5);
    expect(pressure({ pointerType: "mouse", pressure: 1 })).toBe(0.5);
    expect(round(1 / 3)).toBe(0.3333);
  });
});

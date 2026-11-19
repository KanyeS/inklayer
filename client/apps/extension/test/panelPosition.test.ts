import { describe, expect, it } from "vitest";
import { clampPosition, parsePosition } from "../src/lib/panelPosition";

describe("panel position", () => {
  const viewport = { width: 1200, height: 800 };
  const panel = { width: 330, height: 500 };

  it("keeps a position that fits", () => {
    expect(clampPosition({ right: 400, bottom: 100 }, panel, viewport)).toEqual({ right: 400, bottom: 100 });
  });

  it("pulls the panel back inside the window", () => {
    expect(clampPosition({ right: -50, bottom: 900 }, panel, viewport)).toEqual({ right: 8, bottom: 292 });
    expect(clampPosition({ right: 5000, bottom: -10 }, panel, viewport)).toEqual({ right: 862, bottom: 8 });
  });

  it("pins to the bottom right when the window is smaller than the panel", () => {
    expect(clampPosition({ right: 300, bottom: 300 }, panel, { width: 300, height: 400 })).toEqual({
      right: 8,
      bottom: 8,
    });
  });

  it("ignores saved values that aren't positions", () => {
    expect(parsePosition({ right: 10, bottom: 20 })).toEqual({ right: 10, bottom: 20 });
    expect(parsePosition({ right: "10", bottom: 20 })).toBeNull();
    expect(parsePosition(undefined)).toBeNull();
  });
});

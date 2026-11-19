import { describe, expect, it } from "vitest";
import { closeEnough, correctedWindowSize, sizeDiffers, windowSizeFor } from "../src/lib/viewportMatch";

describe("matching the commenter's window size", () => {
  it("only mentions sizes that differ enough to change the layout", () => {
    expect(sizeDiffers(390, 1440)).toBe(true);
    expect(sizeDiffers(1420, 1440)).toBe(false);
    expect(sizeDiffers(1920, 1440)).toBe(true);
    expect(sizeDiffers(0, 1440)).toBe(false); // unknown
  });

  it("adds the browser's frame to the page size", () => {
    const now = { innerWidth: 1440, innerHeight: 800, outerWidth: 1456, outerHeight: 920 };
    expect(windowSizeFor({ width: 768, height: 1024 }, now)).toEqual({ width: 784, height: 1144 });
    expect(windowSizeFor({ width: 768 }, now)).toEqual({ width: 784 });
  });
});

describe("correcting a resize that missed", () => {
  it("counts a couple of pixels off as there", () => {
    expect(closeEnough({ width: 390, height: 844 }, { width: 391, height: 842 })).toBe(true);
    expect(closeEnough({ width: 390, height: 844 }, { width: 394, height: 844 })).toBe(false);
  });

  it("ignores height when it isn't known", () => {
    expect(closeEnough({ width: 390, height: null }, { width: 390, height: 300 })).toBe(true);
  });

  it("scales the gap by how many screen units a CSS pixel took", () => {
    // Display scaling 2: the window grew 200 screen units, the page 100 CSS pixels.
    const before = { window: { width: 1000, height: 800 }, page: { width: 984, height: 700 } };
    const after = { window: { width: 800, height: 600 }, page: { width: 884, height: 600 } };
    expect(correctedWindowSize({ width: 784, height: 550 }, before, after)).toEqual({ width: 600, height: 500 });
  });

  it("assumes one screen unit per pixel when nothing changed", () => {
    const same = { window: { width: 800, height: 600 }, page: { width: 784, height: 500 } };
    expect(correctedWindowSize({ width: 390, height: null }, same, same)).toEqual({ width: 406 });
  });
});

import { describe, expect, it } from "vitest";
import { sizeDiffers, windowSizeFor } from "../src/lib/viewportMatch";

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

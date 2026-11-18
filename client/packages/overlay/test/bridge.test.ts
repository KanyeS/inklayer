import { describe, expect, it } from "vitest";
import { fromFraction, toFraction, unwrapHostMessage, unwrapOverlayMessage, wrap } from "../src";

describe("bridge", () => {
  it("accepts well-formed messages in each direction only", () => {
    expect(unwrapHostMessage(wrap({ type: "clearDraft" }))).toEqual({ type: "clearDraft" });
    expect(unwrapOverlayMessage(wrap({ type: "selected", id: "a" }))).toEqual({ type: "selected", id: "a" });
    expect(unwrapHostMessage(wrap({ type: "draft" }))).toBeNull(); // overlay->host type sent the wrong way
    expect(unwrapOverlayMessage(wrap({ type: "setTool" }))).toBeNull();
  });

  it("ignores anything that isn't an Inklayer envelope", () => {
    for (const data of [null, "setTool", { type: "setTool" }, { protocol: "other", version: 1, message: { type: "clearDraft" } },
      { protocol: "inklayer-overlay", version: 2, message: { type: "clearDraft" } }, { protocol: "inklayer-overlay", version: 1, message: "x" }]) {
      expect(unwrapHostMessage(data)).toBeNull();
    }
  });
});

describe("geometry", () => {
  it("converts between document points and fractions of a box", () => {
    const box = { x: 100, y: 50, width: 200, height: 100 };

    expect(toFraction({ x: 200, y: 100 }, box)).toEqual({ x: 0.5, y: 0.5 });
    expect(fromFraction({ x: 1.5, y: -0.5 }, box)).toEqual({ x: 400, y: 0 });
    expect(fromFraction(toFraction({ x: 7, y: 9 }, { x: 0, y: 0, width: 0, height: 0 }), { x: 0, y: 0, width: 0, height: 0 })).toEqual({ x: 7, y: 9 });
  });
});

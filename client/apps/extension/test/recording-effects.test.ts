import { afterEach, describe, expect, it } from "vitest";
import { FADE_MS, fadeOf, RecordingEffects } from "../src/live/recording-effects";

describe("recording effects", () => {
  afterEach(() => {
    for (const el of document.querySelectorAll("inklayer-effects")) el.remove();
  });

  it("keeps a drawn line solid for a moment, then fades it out", () => {
    expect(fadeOf(0)).toBe(1);
    expect(fadeOf(FADE_MS * 0.4)).toBe(1);
    expect(fadeOf(FADE_MS * 0.7)).toBeCloseTo(0.5, 5);
    expect(fadeOf(FADE_MS)).toBe(0);
    expect(fadeOf(FADE_MS * 2)).toBe(0);
  });

  it("is on the page only while it's being recorded", () => {
    const effects = new RecordingEffects();
    effects.toggleDrawing(); // not recording: nothing
    expect(document.querySelector("inklayer-effects")).toBeNull();

    effects.setRecording(true);
    const layer = document.querySelector("inklayer-effects") as HTMLElement;
    expect(layer).not.toBeNull();
    // Under Inklayer's panel, and out of the way of the page unless drawing.
    expect(layer.getAttribute("style")).toContain("z-index:2147483646");
    expect(layer.getAttribute("style")).toContain("pointer-events:none");

    effects.setRecording(false);
    expect(document.querySelector("inklayer-effects")).toBeNull();
  });
});

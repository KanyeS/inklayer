import { afterEach, describe, expect, it, vi } from "vitest";
import { NextFrame } from "../src/live/next-frame";

describe("next frame", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does the work once a frame, however often it's asked, and in full if any request asked for it", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
    const run = vi.fn();
    const next = new NextFrame(run);

    // Typing: many requests for just the panel.
    next.request(false);
    next.request(false);
    next.request(false);
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    expect(run).toHaveBeenCalledExactlyOnceWith(false);

    // Then something that needs the bubbles too.
    next.request(false);
    next.request(true);
    frames.shift()?.(0);
    expect(run).toHaveBeenLastCalledWith(true);
    expect(frames).toHaveLength(0);
  });
});

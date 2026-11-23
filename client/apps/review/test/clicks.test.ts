import { afterEach, describe, expect, it, vi } from "vitest";
import { ring, showClicks } from "../src/page/clicks";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("click rings in recordings", () => {
  it("draws a ring where the pointer went down, over everything, without catching clicks", () => {
    showClicks(document);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, clientY: 50, bubbles: true }));
    const drawn = document.querySelector<HTMLElement>("[data-inklayer-click]");
    expect(drawn?.style.left).toBe("86px");
    expect(drawn?.style.top).toBe("36px");
    expect(drawn?.style.pointerEvents).toBe("none");
    expect(drawn?.getAttribute("aria-hidden")).toBe("true");
  });

  it("removes the ring once it has faded", () => {
    vi.useFakeTimers();
    const drawn = ring(document, 10, 10);
    expect(drawn.isConnected).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(drawn.isConnected).toBe(false);
  });
});

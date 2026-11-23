import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFullPageFrame, captureTab, finishFullPage, NOT_IN_FRONT, startFullPage } from "../src/lib/screenshots";

/** A window whose tab in front is `active()` each time it's asked (the person can switch while a shot is taken). */
function browser(active: () => number) {
  const captureVisibleTab = vi.fn(async () => "data:image/png;base64,");
  vi.stubGlobal("chrome", { tabs: { query: vi.fn(async () => [{ id: active() }]), captureVisibleTab } });
  return { captureVisibleTab };
}

afterEach(() => vi.unstubAllGlobals());

describe("screenshots", () => {
  it("takes the page when its tab is in front", async () => {
    const { captureVisibleTab } = browser(() => 7);
    expect(await captureTab(1, 7)).toBe("data:image/png;base64,");
    expect(captureVisibleTab).toHaveBeenCalledWith(1, { format: "png" });
  });

  it("takes nothing when another tab is in front", async () => {
    const { captureVisibleTab } = browser(() => 8);
    await expect(captureTab(1, 7)).rejects.toThrow(NOT_IN_FRONT);
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it("drops the shot when the person switched tabs while it was taken", async () => {
    const answers = [7, 8];
    browser(() => answers.shift() ?? 8);
    await expect(captureTab(1, 7)).rejects.toThrow(NOT_IN_FRONT);
  });

  it("drops a whole full-page screenshot once the page isn't in front", async () => {
    vi.stubGlobal("OffscreenCanvas", class {});
    browser(() => 8);
    startFullPage("c1", 1000, 3000);
    await expect(captureFullPageFrame(1, 7, "c1", 0)).rejects.toThrow(NOT_IN_FRONT);
    await expect(finishFullPage("c1")).rejects.toThrow("No full-page screenshot");
  });
});

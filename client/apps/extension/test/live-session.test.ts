import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePage } from "../src/lib/live";
import { LiveSession, PANEL_STYLES } from "../src/live/session";
import { annotation, clickButton, fakeChrome, init, texts } from "./live-fixtures";

/**
 * The live panel end to end, in a simulated page: the session with its real views, a fake background answering its
 * requests. The panel's shadow root is closed, so the test keeps a reference to it as it's made.
 */

/** jsdom has no layout, so no ResizeObserver (the overlay watches the page's size with one). */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => undefined;

let shadowRoots: ShadowRoot[] = [];
let fake: ReturnType<typeof fakeChrome>;
let pages: LivePage[];

function panel(): ShadowRoot {
  const root = shadowRoots.find((r) => r.host.localName === "inklayer-live");
  if (!root) throw new Error("The panel wasn't made");
  return root;
}

async function settle(): Promise<void> {
  await vi.waitFor(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  shadowRoots = [];
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = attach.call(this, init);
    shadowRoots.push(root);
    return root;
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined }));
  pages = [{ projectId: "p1", pageUrl: location.href, annotations: [annotation()] }];
  fake = fakeChrome((message) => {
    if (message.type === "live.list") return pages;
    if (message.type === "live.activity") return { items: [], kinds: ["comments"], nextBefore: null };
    if (message.type === "live.font") throw new Error("no font in tests");
    return null;
  });
  vi.stubGlobal("chrome", fake.chrome);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const el of document.documentElement.querySelectorAll("inklayer-live, inklayer-bubbles")) el.remove();
});

describe("the live panel", () => {
  it("has the theme's tokens and the panel's own styles", () => {
    expect(PANEL_STYLES).toContain(":host");
    expect(PANEL_STYLES).toContain(".launcher");
    expect(PANEL_STYLES).not.toContain(":root");
  });

  it("starts collapsed, with the open-comment count", async () => {
    const session = new LiveSession(init({ pages }));
    await session.start(false);
    const launcher = panel().querySelector(".launcher") as HTMLButtonElement;
    expect(launcher.querySelector(".count")?.textContent).toBe("1");
    expect(panel().querySelector("style")?.textContent).toBe(PANEL_STYLES);
  });

  it("opens to the tools and the page's comments", async () => {
    const session = new LiveSession(init({ pages }));
    await session.start(false);
    (panel().querySelector(".launcher") as HTMLButtonElement).click();
    expect(texts(panel(), ".tab")).toEqual(["Comments", "Activity"]);
    expect(panel().querySelector(".hint")?.textContent).toBe("New comments go to Website.");
    expect(texts(panel(), ".tool")).toEqual(["Select", "Pin", "Element", "Text", "Box", "Arrow", "Draw"]);
    expect(texts(panel(), ".list .body")).toEqual(["Fix this"]);
  });

  it("resolves a comment through the background, then reloads", async () => {
    const session = new LiveSession(init({ pages }));
    await session.start(true);
    clickButton(panel(), "Resolve");
    await settle();
    expect(fake.sendMessage).toHaveBeenCalledWith({ type: "live.update", id: "a1", version: 1, status: "Resolved" });
    expect(fake.sendMessage).toHaveBeenCalledWith({ type: "live.list", url: location.href });
  });

  it("hides resolved comments behind a toggle", async () => {
    pages = [{ projectId: "p1", pageUrl: location.href, annotations: [annotation({ status: "Resolved" })] }];
    const session = new LiveSession(init({ pages }));
    await session.start(true);
    expect(panel().querySelector(".empty")?.textContent).toBe("No open comments.");
    clickButton(panel(), "Show resolved (1)");
    expect(texts(panel(), ".list .body")).toEqual(["Fix this"]);
    expect(texts(panel(), "button.link")).toContain("Hide resolved");
  });

  it("says when a comment to open isn't on the page", async () => {
    const session = new LiveSession(init({ pages }));
    await session.start(false);
    session.focusComment("gone");
    expect(panel().querySelector(".error")?.textContent).toBe(
      "That comment isn't on this version of the page, or was deleted.",
    );
  });

  it("selects a comment it's asked to open", async () => {
    const session = new LiveSession(init({ pages }));
    await session.start(false);
    session.focusComment("a1");
    expect(panel().querySelector("li.item.selected")?.getAttribute("data-id")).toBe("a1");
  });

  it("loads the activity log when its tab is opened", async () => {
    const session = new LiveSession(init({ pages }));
    await session.start(true);
    clickButton(panel(), "Activity");
    await settle();
    expect(fake.sendMessage).toHaveBeenCalledWith({ type: "live.activity", thisSite: true });
    expect(panel().querySelector(".tab.active")?.textContent).toBe("Activity");
    expect(panel().querySelector(".empty")?.textContent).toBe("No activity on this site yet.");
  });

  it("minimises back to the launcher", async () => {
    const session = new LiveSession(init({ pages }));
    await session.start(true);
    (panel().querySelector('[title="Minimise"]') as HTMLButtonElement).click();
    expect(panel().querySelector(".panel")).toBeNull();
    expect(panel().querySelector(".launcher")).not.toBeNull();
  });

  it("remembers whether bubbles stay open", async () => {
    const session = new LiveSession(init({ pages }));
    await session.start(true);
    (panel().querySelector(".actions .icon.svg:not(.bell)[aria-pressed]") as HTMLButtonElement).click();
    await settle();
    expect(fake.stored.bubblesOpen).toBe(true);
  });

  it("tells viewers they can't comment", async () => {
    const viewer = init({ pages, projects: [{ ...init().projects[0]!, canComment: false }] });
    const session = new LiveSession(viewer);
    await session.start(true);
    expect(panel().querySelector(".hint")?.textContent).toBe("You can view comments here, but not add them (Viewer).");
    expect(panel().querySelector(".tools")).toBeNull();
  });
});

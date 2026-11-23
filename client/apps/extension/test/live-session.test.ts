import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePage } from "../src/lib/live";
import { LiveSession, PANEL_STYLES } from "../src/live/session";
import { annotation, clickButton, fakeChrome, init, project, texts } from "./live-fixtures";

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

describe("showing some products' comments", () => {
  const website = project();
  const shop = project({ id: "p2", name: "Shop", organizationId: "o2", organizationName: "Beta" });
  const blog = project({ id: "p3", name: "Blog", organizationId: "o2", organizationName: "Beta" });

  beforeEach(() => {
    pages = [
      { projectId: "p1", pageUrl: location.href, annotations: [annotation({ id: "a1", body: "Website note" })] },
      {
        projectId: "p2",
        pageUrl: location.href,
        annotations: [annotation({ id: "a2", projectId: "p2", body: "Shop note" })],
      },
      {
        projectId: "p3",
        pageUrl: location.href,
        annotations: [annotation({ id: "a3", projectId: "p3", body: "Blog note" })],
      },
    ];
  });

  /** Clicks the tick box labelled `label` in the "Showing" checklist. */
  const tick = (label: string) => {
    const choice = [...panel().querySelectorAll(".filter-menu label")].find((l) => l.textContent?.startsWith(label));
    if (!choice) throw new Error(`No choice "${label}"`);
    (choice.querySelector("input") as HTMLInputElement).click();
  };
  const showing = () => panel().querySelector(".filter summary .value")?.textContent;

  it("shows every product's comments, ticked and grouped by organisation, until some are unticked", async () => {
    const session = new LiveSession(init({ pages, projects: [website, shop, blog] }));
    await session.start(true);
    expect(texts(panel(), ".list .body")).toEqual(["Website note", "Shop note", "Blog note"]);
    expect(showing()).toBe("All products");
    expect(texts(panel(), ".filter-menu .org-name")).toEqual(["Acme", "Beta"]);
    expect(
      [...panel().querySelectorAll<HTMLInputElement>(".filter-menu label:not(.page-only) input")].every(
        (i) => i.checked,
      ),
    ).toBe(true);
  });

  /** The product names the "Showing" checklist lists. */
  const listed = () =>
    [...panel().querySelectorAll(".filter-menu .org > .choice:not(.org-name)")].map(
      (l) => l.textContent?.replace(/\s*\(\d+\)$/, "") ?? "",
    );

  it("lists only the products with comments on this page when asked", async () => {
    pages = [pages[0]!, pages[1]!];
    const session = new LiveSession(init({ pages, projects: [website, shop, blog] }));
    await session.start(true);
    expect(listed()).toEqual(["Website", "Shop", "Blog"]);

    tick("On this page only");
    await settle();
    expect(listed()).toEqual(["Website", "Shop"]);
    expect(texts(panel(), ".filter-menu .org-name")).toEqual(["Acme", "Beta"]);

    tick("On this page only");
    await settle();
    expect(listed()).toEqual(["Website", "Shop", "Blog"]);
  });

  it("stays open when pressing inside it, and closes when pressing elsewhere in the panel or on the page", async () => {
    const session = new LiveSession(init({ pages, projects: [website, shop, blog] }));
    await session.start(true);
    const menu = panel().querySelector(".filter") as HTMLDetailsElement;
    const press = (el: Element) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));

    menu.open = true;
    for (const inside of [".page-only", ".search-toggle", ".filter-menu > .choice"]) {
      press(panel().querySelector(inside) as Element);
      expect(menu.open).toBe(true);
    }
    press(panel().querySelector(".list") as Element);
    expect(menu.open).toBe(false);

    menu.open = true;
    press(document.body);
    expect(menu.open).toBe(false);
  });

  it("remembers on this page only and the search for every site", async () => {
    pages = [pages[0]!, pages[1]!];
    const session = new LiveSession(init({ pages, projects: [website, shop, blog] }));
    await session.start(true);
    tick("On this page only");
    await settle();
    expect(fake.stored.productMenu).toEqual({ pageOnly: true, search: null });

    (panel().querySelector(".search-toggle") as HTMLButtonElement).click();
    await settle();
    const box = panel().querySelector(".filter-search") as HTMLInputElement;
    box.value = "acme";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(fake.stored.productMenu).toEqual({ pageOnly: true, search: "acme" });
  });

  it("starts with the checklist narrowed down as it was left", async () => {
    pages = [pages[0]!, pages[1]!];
    fake.stored.productMenu = { pageOnly: true, search: "beta" };
    const session = new LiveSession(init({ pages, projects: [website, shop, blog] }));
    await session.start(true);
    await settle();
    expect((panel().querySelector(".filter-search") as HTMLInputElement).value).toBe("beta");
    expect(listed()).toEqual(["Shop"]);
  });

  it("searches the products by name or organisation from the search icon", async () => {
    const session = new LiveSession(init({ pages, projects: [website, shop, blog] }));
    await session.start(true);
    expect(panel().querySelector(".filter-search")).toBeNull();

    (panel().querySelector(".search-toggle") as HTMLButtonElement).click();
    await settle();
    const box = panel().querySelector(".filter-search") as HTMLInputElement;
    const type = async (text: string) => {
      box.value = text;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    };

    await type("sho");
    expect(listed()).toEqual(["Shop"]);
    await type("beta");
    expect(listed()).toEqual(["Shop", "Blog"]);
    await type("nothing");
    expect(panel().querySelector(".filter-empty")?.textContent).toBe("No products match.");

    (panel().querySelector(".search-toggle") as HTMLButtonElement).click();
    await settle();
    expect(panel().querySelector(".filter-search")).toBeNull();
    expect(listed()).toEqual(["Website", "Shop", "Blog"]);
  });

  it("shows several products at once and remembers them for this site", async () => {
    const session = new LiveSession(init({ pages, projects: [website, shop, blog] }));
    await session.start(true);

    tick("Website");
    await settle();
    expect(texts(panel(), ".list .body")).toEqual(["Shop note", "Blog note"]);
    expect(showing()).toBe("Shop, Blog");
    expect(fake.stored.liveSiteProducts).toEqual({ [location.origin]: ["p2", "p3"] });

    tick("All products");
    await settle();
    expect(texts(panel(), ".list .body")).toEqual(["Website note", "Shop note", "Blog note"]);
    expect(fake.stored.liveSiteProducts).toEqual({});
  });

  it("ticks or unticks a whole organisation", async () => {
    const session = new LiveSession(init({ pages, projects: [website, shop, blog] }));
    await session.start(true);
    tick("Beta");
    await settle();
    expect(texts(panel(), ".list .body")).toEqual(["Website note"]);
    tick("Beta");
    await settle();
    expect(showing()).toBe("All products");
  });

  it("keeps at least one product ticked", async () => {
    const session = new LiveSession(init({ pages, projects: [website, shop, blog], siteProjectIds: ["p2"] }));
    await session.start(true);
    const shopBox = [...panel().querySelectorAll(".filter-menu label")]
      .find((l) => l.textContent?.startsWith("Shop"))
      ?.querySelector("input") as HTMLInputElement;
    expect(shopBox.disabled).toBe(true);
  });

  it("starts on the products picked for this site, and new comments go to one of them", async () => {
    const session = new LiveSession(
      init({ pages, projects: [website, shop, blog], siteProjectIds: ["p2", "p3"], lastProjectId: "p3" }),
    );
    await session.start(true);
    expect(texts(panel(), ".list .body")).toEqual(["Shop note", "Blog note"]);
    expect((panel().querySelector(".target:not(.filter) select") as HTMLSelectElement).value).toBe("p3");
  });

  it("adds the product new comments go to, so they stay in view", async () => {
    const session = new LiveSession(init({ pages, projects: [website, shop, blog], siteProjectIds: ["p2"] }));
    await session.start(true);
    const target = panel().querySelector(".target:not(.filter) select") as HTMLSelectElement;
    target.value = "p1";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(showing()).toBe("Website, Shop");
  });

  it("points to comments in other products when the ones shown have none", async () => {
    pages = [pages[1]!];
    const session = new LiveSession(init({ pages, projects: [website, shop], siteProjectIds: ["p1"] }));
    await session.start(true);
    expect(panel().querySelector(".empty")?.textContent).toBe("No comments on this page yet. 1 in another product");
    clickButton(panel(), "1 in another product");
    expect(texts(panel(), ".list .body")).toEqual(["Shop note"]);
  });

  it("shows all products to open a comment from another one, without changing the site's choice", async () => {
    const session = new LiveSession(init({ pages, projects: [website, shop], siteProjectIds: ["p1"] }));
    await session.start(false);
    session.focusComment("a2");
    expect(panel().querySelector("li.item.selected")?.getAttribute("data-id")).toBe("a2");
    expect(fake.stored.liveSiteProducts).toBeUndefined();
  });

  it("has no menu with only one product", async () => {
    const session = new LiveSession(init({ pages: [pages[0]!], projects: [website] }));
    await session.start(true);
    expect(panel().querySelector(".filter")).toBeNull();
  });
});

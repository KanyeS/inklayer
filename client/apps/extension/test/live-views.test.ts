import { h, render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inboxItemUrl } from "../src/lib/inbox-text";
import { ICON_NAMES, icon } from "../src/live/icons";
import { ActivityView, activityVerb } from "../src/live/views/activity";
import {
  copyButton,
  cornerPin,
  type HeaderOptions,
  header,
  launcher,
  sharedBox,
  sizeBar,
} from "../src/live/views/chrome";
import { bubbleContent, type CommentActions, type ListEntryOptions, listEntry } from "../src/live/views/comment";
import { CommentParts } from "../src/live/views/comment-parts";
import { cannotComment, draftBox, isChosen, scopeChooser, toolbar } from "../src/live/views/composer";
import { InboxView } from "../src/live/views/inbox";
import {
  ALL_FEATURES,
  annotation,
  clickButton,
  fakeChrome,
  fakeContext,
  init,
  mount,
  mountOne,
  project,
  texts,
} from "./live-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("icons", () => {
  it.each(ICON_NAMES)("%s is a line icon with paths", (name) => {
    const svg = mountOne(icon(name));
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelectorAll("path").length).toBeGreaterThan(0);
  });
});

describe("launcher", () => {
  it("shows open comments and unread notifications", () => {
    const button = mountOne(
      launcher({ openCount: 3, unread: 120, pinned: true, onOpen: vi.fn(), onDragStart: vi.fn() }),
    );
    expect(button.querySelector(".count")?.textContent).toBe("3");
    expect(button.querySelector(".count")?.getAttribute("title")).toBe("3 open comments on this page");
    expect(button.querySelector(".bell-count")?.textContent).toBe("99");
    expect(button.classList.contains("movable")).toBe(false);
  });

  it("greys out a zero count and hides the bell with nothing unread", () => {
    const button = mountOne(
      launcher({ openCount: 0, unread: 0, pinned: false, onOpen: vi.fn(), onDragStart: vi.fn() }),
    );
    expect(button.querySelector(".count")?.className).toBe("count zero");
    expect(button.querySelector(".bell-count")).toBeNull();
    expect(button.classList.contains("movable")).toBe(true);
  });

  it("opens on click and starts a drag on press", () => {
    const onOpen = vi.fn();
    const onDragStart = vi.fn();
    const button = mountOne(launcher({ openCount: 1, unread: 0, pinned: true, onOpen, onDragStart }));
    button.click();
    button.dispatchEvent(new Event("pointerdown"));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onDragStart).toHaveBeenCalledOnce();
  });
});

describe("header", () => {
  const options = (overrides: Partial<HeaderOptions> = {}): HeaderOptions => ({
    view: "comments",
    busy: false,
    unread: 0,
    shareProject: "Website",
    bubblesOpen: false,
    marksVisible: true,
    pinned: true,
    justDragged: () => false,
    onView: vi.fn(),
    onShare: vi.fn(),
    onBubblesOpen: vi.fn(),
    onMarksVisible: vi.fn(),
    onMinimise: vi.fn(),
    onDragStart: vi.fn(),
    onResetPosition: vi.fn(),
    ...overrides,
  });

  it("has the two tabs, with the current one active", () => {
    const bar = mountOne(header(options({ view: "activity" })));
    expect(texts(bar, ".tab")).toEqual(["Comments", "Activity"]);
    expect(bar.querySelector(".tab.active")?.textContent).toBe("Activity");
  });

  it("switches tabs, and the bell toggles the inbox", () => {
    const o = options({ unread: 4 });
    const bar = mountOne(header(o));
    clickButton(bar, "Activity");
    expect(o.onView).toHaveBeenCalledWith("activity");
    (bar.querySelector(".bell") as HTMLButtonElement).click();
    expect(o.onView).toHaveBeenCalledWith("inbox");
    expect(bar.querySelector(".bell .badge")?.textContent).toBe("4");
  });

  it("leaves out sharing when there's nothing to share", () => {
    expect(mountOne(header(options())).querySelectorAll(".actions button")).toHaveLength(5);
    expect(mountOne(header(options({ shareProject: null }))).querySelectorAll(".actions button")).toHaveLength(4);
  });

  it("toggles bubbles and marks to the opposite of now", () => {
    const o = options({ bubblesOpen: true, marksVisible: false });
    const bar = mountOne(header(o));
    (bar.querySelector('[aria-pressed="true"]') as HTMLButtonElement).click();
    expect(o.onBubblesOpen).toHaveBeenCalledWith(false);
    (bar.querySelector('[title="Show marks on the page"]') as HTMLButtonElement).click();
    expect(o.onMarksVisible).toHaveBeenCalledWith(true);
  });

  it("shows a grip and resets on double-click only while unpinned", () => {
    expect(mountOne(header(options())).querySelector(".grip")).toBeNull();
    const o = options({ pinned: false });
    const bar = mountOne(header(o));
    expect(bar.querySelector(".grip")).not.toBeNull();
    bar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(o.onResetPosition).toHaveBeenCalledOnce();
  });

  it("swallows the click that ends a drag", () => {
    const o = options({ justDragged: () => true });
    const bar = mountOne(header(o));
    clickButton(bar, "Activity");
    expect(o.onView).not.toHaveBeenCalled();
  });
});

describe("notices", () => {
  it("pins and unpins from the corner", () => {
    const onToggle = vi.fn();
    const pin = mountOne(cornerPin(true, onToggle));
    expect(pin.className).toBe("corner-pin on");
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    pin.click();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(mountOne(cornerPin(false, onToggle)).className).toBe("corner-pin");
  });

  it("says what size the page is shown at", () => {
    expect(mountOne(sizeBar({ width: 390, height: 844 }, vi.fn())).textContent).toContain("390×844.");
    expect(mountOne(sizeBar({ width: 390, height: null }, vi.fn())).textContent).toContain("390px wide.");
    expect(mountOne(sizeBar("unknown", vi.fn())).textContent).toContain("resized to a commenter's size");
  });

  it("explains a share link", () => {
    const box = mountOne(
      sharedBox(
        { url: "https://ink.test/s/abc", existing: true, expiresAt: null, projectName: "Website", copied: true },
        vi.fn(),
      ),
    );
    expect(box.querySelector("strong")?.textContent).toBe("This page's share link");
    expect(box.querySelector(".share-url")?.getAttribute("href")).toBe("https://ink.test/s/abc");
    expect(box.querySelector(".hint")?.textContent).toBe(
      "It already existed, so it's the same link as before. Copied. Anyone with it can read this page's open comments in Website, with no end date. Turn it off from the project's Sharing tab.",
    );
  });

  it("copy buttons say whether copying worked, then reset", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => undefined) } });
    const button = mountOne(copyButton("Copy link", "https://x.test"));
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(button.textContent).toBe("Copied");
    await vi.advanceTimersByTimeAsync(1500);
    expect(button.textContent).toBe("Copy link");
    vi.useRealTimers();
  });
});

describe("making a comment", () => {
  it("says where comments go, with a menu when there's a choice", () => {
    const one = toolbar({
      commentable: [project()],
      target: project(),
      tool: "select",
      color: "#f59e0b",
      drafting: false,
      onTarget: vi.fn(),
      onTool: vi.fn(),
      onColor: vi.fn(),
    });
    expect(mount(one).firstElementChild?.textContent).toBe("New comments go to Website.");

    const two = [project(), project({ id: "p2", name: "App" })];
    const onTarget = vi.fn();
    const many = toolbar({
      commentable: two,
      target: two[0]!,
      tool: "select",
      color: "#f59e0b",
      drafting: false,
      onTarget,
      onTool: vi.fn(),
      onColor: vi.fn(),
    });
    const select = mount(many).querySelector("select") as HTMLSelectElement;
    expect(texts(select, "option")).toEqual(["Acme / Website", "Acme / App"]);
    select.value = "p2";
    select.dispatchEvent(new Event("change"));
    expect(onTarget).toHaveBeenCalledWith("p2");
  });

  it("marks the current tool and colour, and hints what to do next", () => {
    const onTool = vi.fn();
    const onColor = vi.fn();
    const parts = toolbar({
      commentable: [project()],
      target: project(),
      tool: "rect",
      color: "#3b82f6",
      drafting: false,
      onTarget: vi.fn(),
      onTool,
      onColor,
    });
    const root = mount(parts);
    expect(root.querySelector(".tool.active")?.textContent).toBe("Box");
    expect(root.querySelector(".swatch.active")?.getAttribute("title")).toBe("#3b82f6");
    expect((root.querySelector(".swatch") as HTMLElement).style.background).not.toBe("");
    expect(root.querySelector(".hint:last-child")?.textContent).toBe("Drag on the page.");
    clickButton(root, "Pin");
    expect(onTool).toHaveBeenCalledWith("pin");
    (root.querySelectorAll(".swatch")[1] as HTMLButtonElement).click();
    expect(onColor).toHaveBeenCalledWith("#ef4444");
  });

  it("explains why someone can't comment", () => {
    expect(mountOne(cannotComment(true)).textContent).toContain("(Viewer)");
    expect(mountOne(cannotComment(false)).textContent).toContain("not in any project");
  });

  it("offers where a comment shows only when the address has more than a path", () => {
    expect(scopeChooser("https://a.test/page", { includeQuery: false, includeHash: false }, vi.fn())).toBeNull();
    const onChange = vi.fn();
    const fieldset = mountOne(
      scopeChooser("https://a.test/page?v=1", { includeQuery: true, includeHash: false }, onChange),
    );
    const radios = [...fieldset.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios.map((r) => r.checked)).toEqual([false, true]);
    radios[0]?.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledWith({ query: false, hash: false });
    expect(
      isChosen(
        { scope: { query: true, hash: false }, label: "", address: "" },
        { includeQuery: true, includeHash: false },
      ),
    ).toBe(true);
  });

  it("builds the draft box with Save, Cancel and the attach option", () => {
    const onSave = vi.fn();
    const onAttachContext = vi.fn();
    const onRemoveRecording = vi.fn();
    const box = mountOne(
      draftBox({
        input: h("textarea", null),
        scope: null,
        busy: false,
        attachContext: true,
        onAttachContext,
        fullPage: false,
        onFullPage: vi.fn(),
        recording: { seconds: 83 },
        recorderOpen: false,
        onRecord: vi.fn(),
        onRecordInWindow: vi.fn(),
        onCloseRecorder: vi.fn(),
        onRemoveRecording,
        issueTitleHint: true,
        onSave,
        onCancel: vi.fn(),
      }),
    );
    expect(box.textContent).toContain("The first line becomes the title of any issue made from it.");
    expect(box.textContent).toContain("Also a full-page screenshot");
    expect(box.textContent).toContain("Recording attached (1:23)");
    clickButton(box, "Remove");
    expect(onRemoveRecording).toHaveBeenCalledOnce();
    clickButton(box, "Save");
    expect(onSave).toHaveBeenCalledOnce();
    const attach = box.querySelector<HTMLInputElement>(".attach input") as HTMLInputElement;
    attach.checked = false;
    attach.dispatchEvent(new Event("change"));
    expect(onAttachContext).toHaveBeenCalledWith(false);
  });

  it("points to the recorder's bar, with a separate window as the fallback", () => {
    const onRecordInWindow = vi.fn();
    const onCloseRecorder = vi.fn();
    const box = mountOne(
      draftBox({
        input: h("textarea", null),
        scope: null,
        busy: false,
        attachContext: true,
        onAttachContext: vi.fn(),
        fullPage: false,
        onFullPage: vi.fn(),
        recording: undefined,
        recorderOpen: true,
        onRecord: vi.fn(),
        onRecordInWindow,
        onCloseRecorder,
        onRemoveRecording: vi.fn(),
        issueTitleHint: false,
        onSave: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(box.textContent).toContain("Recording controls are at the bottom of the page.");
    clickButton(box, "Use a separate window");
    clickButton(box, "Cancel");
    expect(onRecordInWindow).toHaveBeenCalledOnce();
    expect(onCloseRecorder).toHaveBeenCalledOnce();
  });

  it("leaves out the attach option without bug context, and says when it's saving", () => {
    const box = mountOne(
      draftBox({
        input: h("textarea", null),
        scope: null,
        busy: true,
        attachContext: null,
        onAttachContext: vi.fn(),
        fullPage: null,
        onFullPage: vi.fn(),
        recording: null,
        recorderOpen: false,
        onRecord: vi.fn(),
        onRecordInWindow: vi.fn(),
        onCloseRecorder: vi.fn(),
        onRemoveRecording: vi.fn(),
        issueTitleHint: false,
        onSave: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(box.querySelector(".attach")).toBeNull();
    expect(box.textContent).not.toContain("becomes the title");
    expect(box.textContent).not.toContain("full-page");
    expect(box.textContent).not.toContain("Record");
    expect(box.querySelector<HTMLButtonElement>(".primary")?.textContent).toBe("Saving…");
    expect(box.querySelector<HTMLButtonElement>(".primary")?.disabled).toBe(true);
  });
});

describe("a comment", () => {
  const actions = (): CommentActions => ({
    setResolved: vi.fn(),
    remove: vi.fn(),
    startEdit: vi.fn(),
    saveEdit: vi.fn(),
    cancelEdit: vi.fn(),
  });
  const parts = (ctx = fakeContext()) =>
    new CommentParts(ctx, {
      canCommentIn: () => true,
      organizationOf: () => "o1",
      lightboxParent: document.body,
      matchSize: vi.fn(),
    });
  const entryOptions = (overrides: Partial<ListEntryOptions> = {}): ListEntryOptions => ({
    label: 2,
    selected: false,
    orphaned: false,
    projectName: null,
    showAddress: false,
    canComment: true,
    editing: null,
    onSelect: vi.fn(),
    actions: actions(),
    ...overrides,
  });

  it("shows its number, author and text in the list", () => {
    const ctx = fakeContext();
    const li = mountOne(listEntry(ctx, parts(ctx), annotation(), entryOptions()));
    expect(li.dataset.id).toBe("a1");
    expect(li.querySelector(".badge")?.textContent).toBe("2");
    expect(li.querySelector(".meta strong")?.textContent).toBe("Ann");
    expect(li.querySelector(".meta strong")?.getAttribute("title")).toBe("Ann Lee · Commenter");
    expect(li.querySelector(".body")?.textContent).toBe("Fix this");
    expect(texts(li, ".actions button")).toEqual(["Resolve", "Edit", "Copy link", "Delete"]);
  });

  it("offers only what the user may do", () => {
    const ctx = fakeContext();
    const a = annotation({ canEdit: false, canDelete: false, status: "Resolved" });
    const li = mountOne(listEntry(ctx, parts(ctx), a, entryOptions({ canComment: false })));
    expect(texts(li, ".actions button")).toEqual(["Copy link"]);
    expect(li.classList.contains("resolved")).toBe(true);
  });

  it("marks a moved comment and names its project when there are several", () => {
    const ctx = fakeContext();
    const li = mountOne(listEntry(ctx, parts(ctx), annotation(), entryOptions({ orphaned: true, projectName: "App" })));
    expect(li.querySelector(".warn")?.textContent).toBe("moved");
    expect(li.textContent).toContain("· App");
  });

  it("resolves, and asks before deleting", () => {
    const ctx = fakeContext();
    const o = entryOptions();
    const li = mountOne(listEntry(ctx, parts(ctx), annotation(), o));
    clickButton(li, "Resolve");
    expect(o.actions.setResolved).toHaveBeenCalledWith(true);
    vi.stubGlobal("confirm", () => false);
    clickButton(li, "Delete");
    expect(o.actions.remove).not.toHaveBeenCalled();
    vi.stubGlobal("confirm", () => true);
    clickButton(li, "Delete");
    expect(o.actions.remove).toHaveBeenCalledOnce();
    expect(o.onSelect).not.toHaveBeenCalled(); // buttons don't also select the comment
  });

  it("counts replies until selected, then shows the thread and a reply box", () => {
    const ctx = fakeContext();
    const reply = {
      id: "r1",
      body: "Done",
      author: { id: "u2", displayName: "Bo", avatarUrl: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      canEdit: false,
      canDelete: false,
    };
    const a = annotation({ replies: [reply, { ...reply, id: "r2" }] });
    const p = parts(ctx);
    expect(mountOne(listEntry(ctx, p, a, entryOptions())).querySelector(".replies-count")?.textContent).toBe(
      "2 replies",
    );
    const selected = mountOne(listEntry(ctx, p, a, entryOptions({ selected: true })));
    expect(selected.querySelectorAll(".reply")).toHaveLength(2);
    expect(selected.querySelector("textarea.reply-box")).not.toBeNull();
  });

  it("shows the edit box instead of the text while editing", () => {
    const ctx = fakeContext();
    const draft = { text: "Fix this", picked: new Map<string, string>() };
    const o = entryOptions({ editing: { draft, onChange: vi.fn(), organizationId: () => "o1" } });
    const li = mountOne(listEntry(ctx, parts(ctx), annotation(), o));
    expect(li.querySelector(".body")).toBeNull();
    clickButton(li, "Save");
    expect(li.querySelector("textarea")?.value).toBe("Fix this");
    expect(o.actions.saveEdit).toHaveBeenCalledWith(draft);
  });

  it("links docs that mention it", () => {
    const ctx = fakeContext();
    const a = annotation({
      mentionedIn: [
        { docId: "d1", title: "Plan" },
        { docId: "d2", title: "Notes" },
      ],
    });
    const line = mountOne(listEntry(ctx, parts(ctx), a, entryOptions())).querySelector(".mentions") as HTMLElement;
    expect(line.textContent).toBe("Mentioned in Plan, Notes");
    expect(line.querySelector("a")?.getAttribute("href")).toBe("https://ink.test/orgs/o1/docs/d1");
  });

  it("has a bubble with a pin, the comment and resolve", () => {
    const ctx = fakeContext();
    const onTogglePin = vi.fn();
    const setResolved = vi.fn();
    const content = bubbleContent(ctx, parts(ctx), annotation({ status: "Resolved" }), {
      pinned: true,
      canComment: true,
      onTogglePin,
      onShowInList: vi.fn(),
      actions: { setResolved },
    });
    const root = mount(content);
    expect(root.querySelector(".pin-toggle.on")).not.toBeNull();
    expect(root.querySelector(".bubble-head")?.textContent).toContain("· resolved");
    (root.querySelector(".pin-toggle") as HTMLButtonElement).click();
    expect(onTogglePin).toHaveBeenCalledOnce();
    clickButton(root, "Reopen");
    expect(setResolved).toHaveBeenCalledWith(false);
  });
});

describe("a comment's parts", () => {
  const parts = (ctx = fakeContext()) =>
    new CommentParts(ctx, {
      canCommentIn: () => true,
      organizationOf: () => "o1",
      lightboxParent: document.body,
      matchSize: vi.fn(),
    });

  it("links docs and shows mentions as names", () => {
    const a = annotation({
      body: "See [[Plan]] and [[Missing]], <@0f8fad5b-d9cb-469f-a165-70867728950e>",
      docLinks: [
        { text: "Plan", docId: "d1", title: "Plan" },
        { text: "Missing", docId: null, title: null },
      ],
      people: [{ id: "0f8fad5b-d9cb-469f-a165-70867728950e", displayName: "Bo", fullName: "Bo Diaz" }],
    });
    const p = mountOne(parts().body(a));
    expect(p.querySelector("a.doclink")?.getAttribute("href")).toBe("https://ink.test/orgs/o1/docs/d1");
    expect(p.querySelector(".doclink.missing")?.textContent).toBe("Missing");
    expect(p.querySelector(".mention")?.textContent).toBe("@Bo");
  });

  it("shows [[links]] as text while docs are off", () => {
    const ctx = fakeContext({ init: init({ features: { ...ALL_FEATURES, docs: false } }) });
    const a = annotation({ body: "See [[Plan]]", docLinks: [{ text: "Plan", docId: "d1", title: "Plan" }] });
    const p = mountOne(parts(ctx).body(a));
    expect(p.querySelector("a")).toBeNull();
    expect(p.textContent).toBe("See [[Plan]]");
  });

  it("summarises page details, folded away", () => {
    const a = annotation({
      context: {
        browser: "Firefox",
        os: "Linux",
        userAgent: "",
        viewportWidth: 800,
        viewportHeight: 600,
        devicePixelRatio: 1,
        selector: "#buy",
        elementHtml: "",
        console: [{ level: "error", message: "boom", at: "" }],
        network: [],
        capturedAt: "",
      },
    });
    const details = mountOne(parts().details(a));
    expect(details.querySelector("summary")?.textContent).toBe("Firefox · Linux · 800×600 · 1 console error");
    expect(details.textContent).toContain("Element: #buy");
    expect(details.querySelector("li.error")?.textContent).toBe("error: boom");
  });

  it("shows nothing for details, screenshots or issues that aren't there", () => {
    const p = parts();
    expect(p.details(annotation())).toBeNull();
    expect(p.screenshot(annotation())).toBeNull();
    expect(p.size(annotation())).toBeNull();
  });

  it("offers to play a recording, in a frame from the extension", async () => {
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome-extension://inklayer/${path}` } });
    const a = annotation({ media: [{ kind: "video", contentType: "video/webm", size: 1000, width: 0, height: 0 }] });
    const box = mount(parts().screenshot(a));
    expect(box.querySelector("iframe")).toBeNull();
    clickButton(box, "▶ Play recording");
    await new Promise((resolve) => setTimeout(resolve, 0)); // the next render
    const frame = box.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.src).toBe(`chrome-extension://inklayer/player.html?id=${a.id}`);
    vi.unstubAllGlobals();
  });

  it("links issues on https only", () => {
    vi.stubGlobal("chrome", fakeChrome(() => []).chrome);
    const a = annotation({
      issues: [
        { id: "i1", kind: "github", key: "#12", url: "https://github.com/x/y/issues/12", state: "open" },
        { id: "i2", kind: "jira", key: "WEB-1", url: "javascript:alert(1)", state: "closed" },
      ],
    });
    const row = mountOne(parts().issues(a));
    expect(texts(row, "a.issue")).toEqual(["● GitHub #12"]);
  });

  it("offers to match the commenter's size when it differs", () => {
    const matchSize = vi.fn();
    const p = new CommentParts(fakeContext(), {
      canCommentIn: () => true,
      organizationOf: () => "o1",
      lightboxParent: document.body,
      matchSize,
    });
    const row = mountOne(p.size(annotation({ viewportWidth: 390, context: null })));
    expect(row.textContent).toContain(`Made at 390px wide · you're at ${innerWidth}px`);
    clickButton(row, "Match their size");
    expect(matchSize).toHaveBeenCalledWith("a1", 390, null, null);
  });

  it("sends a reply with Enter and keeps the box across renders", async () => {
    const ctx = fakeContext();
    const fake = fakeChrome();
    vi.stubGlobal("chrome", fake.chrome);
    const p = parts(ctx);
    const a = annotation();
    // Re-render when the parts ask to, as the session does.
    const root = mount(null);
    const draw = () => render(p.replyBox(a, "panel"), root);
    ctx.render.mockImplementation(draw);
    draw();
    const box = root.querySelector("textarea") as HTMLTextAreaElement;

    box.value = "On it";
    box.dispatchEvent(new Event("input"));
    draw();
    expect(root.querySelector("textarea")).toBe(box);
    expect(box.value).toBe("On it");
    expect(p.hasReplyDraft("panel", "a1")).toBe(true);
    expect(p.hasReplyDraft("bubble", "a1")).toBe(false);

    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(box.value).toBe("");
    expect(ctx.mutate).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(fake.sendMessage).toHaveBeenCalledWith({ type: "live.reply", annotationId: "a1", body: "On it" }),
    );
  });
});

describe("activity", () => {
  it("names what happened", () => {
    expect(activityVerb({ kind: "comments", action: "resolved" })).toBe("resolved a comment");
    expect(activityVerb({ kind: "docs", action: "renamed" })).toBe("renamed a doc");
    expect(activityVerb({ kind: "errors", action: "something_new" })).toBe("something_new");
  });

  it("loads when opened, once, and lists entries", async () => {
    const fake = fakeChrome(() => ({
      items: [
        {
          id: "e1",
          kind: "comments",
          action: "created",
          occurredAt: new Date().toISOString(),
          actor: { id: "u1", displayName: "Ann", email: null },
          projectId: "p1",
          projectName: "Website",
          pageUrl: "https://site.test/page",
          annotationId: "a1",
          detail: null,
        },
      ],
      kinds: ["comments"],
      nextBefore: "cursor",
    }));
    vi.stubGlobal("chrome", fake.chrome);
    const ctx = fakeContext({ onThisPage: ["a1"] });
    const view = new ActivityView(ctx);
    expect(view.parts()).toBeNull();
    view.open();
    view.open();
    await vi.waitFor(() => expect(ctx.render).toHaveBeenCalledTimes(2));
    expect(fake.sendMessage).toHaveBeenCalledOnce();
    expect(fake.sendMessage).toHaveBeenCalledWith({ type: "live.activity", thisSite: true });

    const root = mount(view.parts());
    const item = root.querySelector("li.item") as HTMLLIElement;
    expect(item.textContent).toContain("Ann commented");
    expect(item.querySelector(".where a")?.textContent).toBe("site.test/page");
    expect(item.classList.contains("here")).toBe(true);
    item.click();
    expect(ctx.showOnPage).toHaveBeenCalledWith("a1");
    expect(texts(root, "button")).toContain("Show older");
  });
});

describe("inbox", () => {
  it("opens notifications in the right place", () => {
    const base = { organizationId: "o1", annotationId: null, docId: null };
    expect(inboxItemUrl({ ...base, annotationId: "a1" }, "https://ink.test")).toBe("https://ink.test/comments/a1");
    expect(inboxItemUrl({ ...base, docId: "d1" }, "https://ink.test")).toBe("https://ink.test/orgs/o1/docs/d1");
    expect(inboxItemUrl(base, "https://ink.test")).toBe("https://ink.test");
  });

  it("lists notifications, marking unread ones", async () => {
    vi.stubGlobal(
      "chrome",
      fakeChrome(() => ({
        unread: 1,
        serverUrl: "https://ink.test",
        items: [
          {
            id: "n1",
            kind: "mention",
            actor: { id: "u2", displayName: "Bo", fullName: "Bo Diaz" },
            organizationId: "o1",
            annotationId: "a9",
            docId: null,
            preview: "@Ann look",
            where: "site.test/page",
            createdAt: new Date().toISOString(),
            read: false,
          },
        ],
      })).chrome,
    );
    const ctx = fakeContext();
    const view = new InboxView(ctx);
    view.unread = 1;
    expect(view.idle).toBe(false);
    await view.load();
    expect(view.idle).toBe(true);
    const root = mount(view.parts());
    expect(root.querySelector(".inbox-head strong")?.textContent).toBe("1 unread");
    expect(root.querySelector(".unread-dot")?.getAttribute("role")).toBe("img");
    expect(root.querySelector("li.item")?.textContent).toContain("Bo mentioned you");
  });

  it("says when there's nothing", async () => {
    vi.stubGlobal("chrome", fakeChrome(() => ({ unread: 0, serverUrl: "https://ink.test", items: [] })).chrome);
    const view = new InboxView(fakeContext());
    await view.load();
    const root = mount(view.parts());
    expect(root.querySelector(".inbox-head strong")?.textContent).toBe("All read");
    expect(root.querySelector(".empty")?.textContent).toContain("Nothing yet.");
  });
});

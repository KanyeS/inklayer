import { anchorFor, type Draft } from "@inklayer/overlay";
import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ImproveBoxes, Improver } from "../src/live/improve";
import { EMPTY_DRAFT, type TextDraft } from "../src/live/suggestions";
import { draftBox } from "../src/live/views/composer";
import { usageText } from "../src/live/views/improve";
import { clickButton, fakeChrome, mountOne } from "./live-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** One comment box with the Improve button, re-rendered on every change like the session does. */
function box(answer: (message: { type: string; text?: string }) => unknown, text = "button broke") {
  const fake = fakeChrome(answer as (message: { type: string }) => unknown);
  vi.stubGlobal("chrome", fake.chrome);
  let draft: TextDraft = { text, picked: new Map([["Sam", "u1"]]) };
  let root: HTMLElement | null = null;
  const show = () => {
    root?.remove();
    root = mountOne(
      draftBox({
        input: h("textarea", { value: draft.text }),
        scope: null,
        busy: false,
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
        improve: improver.controls(
          "draft:1",
          () => draft,
          (d) => {
            draft = d;
          },
          () => ({ url: "https://site.example/" }),
        ),
        onSave: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
  };
  const improver = new Improver(boxes({ render: show }));
  show();
  return {
    fake,
    get root() {
      return root as unknown as HTMLElement;
    },
    get draft() {
      return draft;
    },
    reset() {
      improver.reset();
    },
    type(next: string) {
      draft = { ...draft, text: next };
      show();
    },
  };
}

/** The session's comment boxes, as Improver sees them: nothing written unless a test says so. */
function boxes(o: Partial<ImproveBoxes>): ImproveBoxes {
  return {
    enabled: () => true,
    render: () => undefined,
    draft: () => null,
    setDraftText: vi.fn(),
    editing: () => null,
    setEditing: vi.fn(),
    ...o,
  };
}

/** A new comment on `el`. */
function draftOn(el: Element): Draft {
  return { kind: "pin", anchor: anchorFor(el), geometry: {}, viewportWidth: 1000 } as unknown as Draft;
}

/** What a rewrite used, as the helper reports it. */
const USAGE = { inputTokens: 9000, outputTokens: 120, costUsd: 0.03, model: "claude-sonnet-4-6", durationMs: 6600 };

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Improve button", () => {
  it("isn't there unless the helper is on", () => {
    const root = mountOne(
      draftBox({
        input: null,
        scope: null,
        busy: false,
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
        improve: null,
        onSave: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(root.textContent).not.toContain("Improve");
  });

  it("puts Claude's rewrite in the box, keeping picked people, and Undo puts the draft back", async () => {
    const b = box(() => ({ text: "The Save button does nothing when clicked. @Sam", usage: USAGE }));
    clickButton(b.root, "Improve");
    expect(b.root.textContent).toContain("Improving…");
    // While Claude works: the box is locked (inert) under a shimmer, Save waits, and a line says what's happening.
    const area = b.root.querySelector<HTMLElement>(".improve-area");
    expect(area?.classList.contains("improving")).toBe(true);
    expect(area?.hasAttribute("inert")).toBe(true);
    expect(area?.querySelector("textarea")).not.toBeNull();
    const save = [...b.root.querySelectorAll("button")].find((x) => x.textContent === "Save");
    expect(save?.disabled).toBe(true);
    expect(b.root.querySelector(".improve-note")?.textContent).toBe("✨ Claude is rewriting your comment…");
    expect(b.root.querySelector("button.improve .spinner")).not.toBeNull();
    await settle();
    expect(b.root.querySelector(".improve-area")?.hasAttribute("inert")).toBe(false);
    expect([...b.root.querySelectorAll("button")].find((x) => x.textContent === "Save")?.disabled).toBe(false);
    expect(b.fake.sendMessage).toHaveBeenCalledWith({
      type: "live.improve",
      url: "https://site.example/",
      text: "button broke",
    });
    expect(b.draft.text).toBe("The Save button does nothing when clicked. @Sam");
    expect(b.draft.picked.get("Sam")).toBe("u1");
    expect(b.root.textContent).toContain(
      "Rewritten by Claude · Sonnet 4.6 · 9,120 tokens · ≈$0.030 at API prices · 6.6 s.",
    );
    clickButton(b.root, "Undo");
    expect(b.draft.text).toBe("button broke");
    expect(b.root.textContent).not.toContain("Rewritten by Claude.");
  });

  it("drops Undo once the person edits the rewrite", async () => {
    const b = box(() => ({ text: "Better.", usage: null }));
    clickButton(b.root, "Improve");
    await settle();
    b.type("Better, edited.");
    expect(b.root.textContent).not.toContain("Undo");
  });

  it("shows what went wrong", async () => {
    const fake = fakeChrome();
    fake.sendMessage.mockResolvedValue({ ok: false, error: "Claude took too long to answer." } as never);
    const b = box(() => null);
    vi.stubGlobal("chrome", fake.chrome);
    clickButton(b.root, "Improve");
    await settle();
    expect(b.root.querySelector(".improve-note.error")?.textContent).toBe("Claude took too long to answer.");
    expect(b.draft.text).toBe("button broke");
  });

  it("asks for some text first", () => {
    const b = box(() => ({ text: "x", usage: null }), "  ");
    clickButton(b.root, "Improve");
    expect(b.fake.sendMessage).not.toHaveBeenCalled();
    expect(b.root.textContent).toContain("Write something first.");
  });

  it("doesn't overwrite what the person typed while Claude was working", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const b = box(() => null);
    b.fake.sendMessage.mockReturnValue(new Promise((r) => (finish = r)) as never);
    clickButton(b.root, "Improve");
    b.type("button broke on Firefox");
    finish({ ok: true, value: { text: "Rewritten.", usage: null } });
    await settle();
    expect(b.draft.text).toBe("button broke on Firefox");
    expect(b.root.textContent).toContain("changed while Claude was working");
  });

  it("forgets the box when it's reset", async () => {
    const b = box(() => ({ text: "Better.", usage: null }));
    clickButton(b.root, "Improve");
    await settle();
    expect(b.root.textContent).toContain("Undo");
    b.reset();
    b.type("Better.");
    expect(b.root.textContent).not.toContain("Undo");
  });

  it("is only offered when the helper is on", () => {
    const draft = { draft: draftOn(document.body), text: EMPTY_DRAFT, url: "https://site.example/", number: 1 };
    expect(new Improver(boxes({ enabled: () => false, draft: () => draft })).forDraft()).toBeNull();
    expect(new Improver(boxes({ draft: () => draft })).forDraft()).not.toBeNull();
    // No draft being written: nothing to improve.
    expect(new Improver(boxes({})).forDraft()).toBeNull();
  });

  it("works on a comment being edited", async () => {
    vi.stubGlobal("chrome", fakeChrome(() => ({ text: "Clearer.", usage: null })).chrome);
    let editing = { id: "c1", draft: { text: "meh", picked: new Map<string, string>() } };
    const setEditing = vi.fn((e: typeof editing) => {
      editing = e;
    });
    const improver = new Improver(boxes({ editing: () => editing, setEditing }));
    expect(improver.forEdit("c2")?.busy).toBe(false);
    improver.forEdit("c1")?.onImprove();
    await settle();
    expect(editing.draft.text).toBe("Clearer.");
    expect(improver.forEdit("c1")?.canUndo).toBe(true);
    improver.forEdit("c1")?.onUndo();
    expect(editing.draft.text).toBe("meh");
  });
});

describe("the offer to set Improve up", () => {
  it("shows under the comment box until the helper is on, and opens the setup in a tab", async () => {
    const fake = fakeChrome();
    vi.stubGlobal("chrome", fake.chrome);
    const improver = new Improver(boxes({ enabled: () => false, offerSetUp: () => true }));
    const hint = improver.setUpHint();
    expect(hint).not.toBeNull();
    hint?.onSetUp();
    await settle();
    expect(fake.sendMessage).toHaveBeenCalledWith({ type: "live.improveSetup" });
    expect(new Improver(boxes({ enabled: () => true, offerSetUp: () => true })).setUpHint()).toBeNull();
    expect(new Improver(boxes({ enabled: () => false, offerSetUp: () => false })).setUpHint()).toBeNull();
  });

  it("stops for good when the person says so", () => {
    const fake = fakeChrome();
    vi.stubGlobal("chrome", fake.chrome);
    const render = vi.fn();
    const improver = new Improver(boxes({ enabled: () => false, offerSetUp: () => true, render }));
    improver.setUpHint()?.onHide();
    expect(improver.setUpHint()).toBeNull();
    expect(fake.stored).toMatchObject({ claudeImproveHintHidden: true });
    expect(render).toHaveBeenCalled();
  });

  it("is a line of two links under the box", () => {
    const onSetUp = vi.fn();
    const onHide = vi.fn();
    const root = mountOne(
      draftBox({
        input: null,
        scope: null,
        busy: false,
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
        improveHint: { onSetUp, onHide },
        onSave: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(root.querySelector(".improve-hint")?.textContent).toBe("✨ Improve with Claude: set up · Don't show this");
    clickButton(root, "Improve with Claude: set up");
    clickButton(root, "Don't show this");
    expect(onSetUp).toHaveBeenCalledOnce();
    expect(onHide).toHaveBeenCalledOnce();
  });
});

describe("what a rewrite used", () => {
  it("says the model, tokens, cost at API prices and time", () => {
    expect(usageText(USAGE)).toBe("Sonnet 4.6 · 9,120 tokens · ≈$0.030 at API prices · 6.6 s");
    expect(usageText({ ...USAGE, model: "claude-haiku-4-5-20251001", costUsd: 0.0004 })).toBe(
      "Haiku 4.5 · 9,120 tokens · ≈<$0.001 at API prices · 6.6 s",
    );
    expect(usageText({ ...USAGE, model: "claude-opus-5", costUsd: 0.25 })).toContain("Opus 5 · 9,120 tokens · ≈$0.25");
    expect(usageText({ inputTokens: 10, outputTokens: 5, costUsd: null, model: null, durationMs: null })).toBe(
      "15 tokens",
    );
  });
});

import { h, render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocLookup, PersonLookup } from "../src/lib/live";
import {
  applySuggestion,
  draftBody,
  draftOf,
  EMPTY_DRAFT,
  SuggestBox,
  type Suggestion,
  type TextDraft,
  typedTrigger,
} from "../src/live/suggestions";
import { mount } from "./live-fixtures";

const doc = (title: string): Suggestion => ({ kind: "doc", doc: { id: "d1", folder: "", title } as DocLookup });
const person = (displayName: string, id = "p1"): Suggestion => ({
  kind: "person",
  person: { id, displayName, fullName: displayName } as PersonLookup,
});

describe("what's being typed", () => {
  it("finds a doc link being typed", () => {
    expect(typedTrigger("See [[Setu", true)).toEqual({ kind: "doc", query: "Setu", start: 4 });
    expect(typedTrigger("[[", true)).toEqual({ kind: "doc", query: "", start: 0 });
  });

  it("ignores doc links while docs are off", () => {
    expect(typedTrigger("See [[Setu", false)).toBeNull();
  });

  it("stops at a closed link, an alias or a heading", () => {
    expect(typedTrigger("[[Setup]] and", true)).toBeNull();
    expect(typedTrigger("[[Setup|the", true)).toBeNull();
    expect(typedTrigger("[[Setup#Ins", true)).toBeNull();
  });

  it("finds a mention at the start or after a space", () => {
    expect(typedTrigger("@ali", true)).toEqual({ kind: "person", query: "ali", start: 0 });
    expect(typedTrigger("thanks @bo", true)).toEqual({ kind: "person", query: "bo", start: 7 });
    expect(typedTrigger("thanks @", true)).toEqual({ kind: "person", query: "", start: 7 });
  });

  it("doesn't take an email address for a mention", () => {
    expect(typedTrigger("mail me@example", true)).toBeNull();
  });

  it("gives up on a mention after a space", () => {
    expect(typedTrigger("@ali done", true)).toBeNull();
  });
});

describe("putting a suggestion in", () => {
  it("closes a doc link and puts the cursor after it", () => {
    expect(applySuggestion("See [[Set", 9, 4, doc("Setup"))).toEqual({ value: "See [[Setup]]", cursor: 13 });
  });

  it("uses the closing ]] already there", () => {
    expect(applySuggestion("See [[Set]] now", 9, 4, doc("Setup"))).toEqual({ value: "See [[Setup]] now", cursor: 13 });
  });

  it("puts a mention in with a space after it", () => {
    expect(applySuggestion("hi @al", 6, 3, person("Alice"))).toEqual({ value: "hi @Alice ", cursor: 10 });
  });

  it("keeps the text after the cursor", () => {
    expect(applySuggestion("@al, thanks", 3, 0, person("Alice"))).toEqual({ value: "@Alice , thanks", cursor: 7 });
  });
});

describe("drafts", () => {
  it("save picked @names as mentions, and show mentions as names for editing", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(draftBody({ text: " hi @Alice ", picked: new Map([["Alice", id]]) })).toBe(`hi <@${id}>`);
    const draft = draftOf(`hi <@${id}>`, [{ id, displayName: "Alice", fullName: "Alice Smith" }]);
    expect(draft.text).toBe("hi @Alice");
    expect(draft.picked.get("Alice")).toBe(id);
  });
});

/** A suggestion box whose draft is kept here, re-rendered on every change (as the panel does). */
function suggestBox(orgId: string | null) {
  const root = mount(null);
  let draft: TextDraft = EMPTY_DRAFT;
  const draw = () =>
    render(
      h(SuggestBox, {
        draft,
        onChange: (next) => {
          draft = next;
          draw();
        },
        organizationId: () => orgId,
        docsOn: true,
      }),
      root,
    );
  draw();
  return { root, box: root.querySelector("textarea") as HTMLTextAreaElement, draft: () => draft };
}

describe("the suggestion list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("sits under the box, hidden until there's something to suggest", () => {
    const { root } = suggestBox(null);
    expect(root.querySelector(".suggest-wrap textarea")).not.toBeNull();
    expect(root.querySelector<HTMLUListElement>("ul.suggest")?.hidden).toBe(true);
  });

  it("looks up people, shows them, and picks one with Enter", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(async () => ({
      ok: true,
      value: [{ id: "p9", displayName: "Alice", fullName: "Alice Smith" }],
    }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { root, box, draft } = suggestBox("org1");

    box.value = "hi @al";
    box.setSelectionRange(6, 6);
    box.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(200);

    expect(sendMessage).toHaveBeenCalledWith({ type: "live.people", orgId: "org1", q: "al" });
    const items = root.querySelectorAll("li");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toBe("@Alice Alice Smith");

    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(box.value).toBe("hi @Alice ");
    expect(draft().picked.get("Alice")).toBe("p9");
    expect(root.querySelector("ul")?.hidden).toBe(true);
  });
});

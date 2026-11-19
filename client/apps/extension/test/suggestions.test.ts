import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocLookup, PersonLookup } from "../src/lib/live";
import { applySuggestion, pickedIn, type Suggestion, typedTrigger, withSuggestions } from "../src/live/suggestions";

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

describe("people picked in a box", () => {
  it("is one map per box, kept", () => {
    const a = document.createElement("textarea");
    const b = document.createElement("textarea");
    pickedIn(a).set("Alice", "p1");
    expect(pickedIn(a).get("Alice")).toBe("p1");
    expect(pickedIn(b).size).toBe(0);
  });
});

describe("the suggestion list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("wraps the box once and reuses its list", () => {
    const input = document.createElement("textarea");
    const first = withSuggestions(input, () => null, true);
    const list = first.querySelector<HTMLUListElement>("ul.suggest");
    expect(first.className).toBe("suggest-wrap");
    expect(list?.hidden).toBe(true);
    // A re-render wraps the same box again: the list moves with it, so nothing typed or shown is lost.
    const second = withSuggestions(input, () => null, true);
    expect(second.querySelector("ul.suggest")).toBe(list);
    expect(second.querySelector("textarea")).toBe(input);
  });

  it("looks up people, shows them, and picks one with Enter", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(async () => ({
      ok: true,
      value: [{ id: "p9", displayName: "Alice", fullName: "Alice Smith" }],
    }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const input = document.createElement("textarea");
    const wrap = withSuggestions(input, () => "org1", true);
    document.body.append(wrap);

    input.value = "hi @al";
    input.setSelectionRange(6, 6);
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(200);

    expect(sendMessage).toHaveBeenCalledWith({ type: "live.people", orgId: "org1", q: "al" });
    const items = wrap.querySelectorAll("li");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toBe("@Alice Alice Smith");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(input.value).toBe("hi @Alice ");
    expect(pickedIn(input).get("Alice")).toBe("p9");
    expect(wrap.querySelector("ul")?.hidden).toBe(true);
    wrap.remove();
  });
});

import type { Draft } from "@inklayer/overlay";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Carry, scopeFor } from "../src/live/carry";
import { fakeChrome } from "./live-fixtures";

const draft = { kind: "pin" } as unknown as Draft;

function setup(drafting = true) {
  const fake = fakeChrome();
  vi.stubGlobal("chrome", fake.chrome);
  const writing = {
    draft,
    text: { text: "Broken here", picked: new Map([["Ana", "u1"]]) },
    color: "#f00",
    scope: { query: false, hash: false },
    projectId: "p1",
  };
  const carry = new Carry(() => (drafting ? writing : null));
  const kept = () =>
    fake.sendMessage.mock.calls
      .map(([m]) => m as { type: string; draft?: { url: string; text: string; picked: unknown } })
      .filter((m) => m.type === "live.recorderDraft");
  return { carry, kept, fake };
}

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("a comment carried while recording", () => {
  it("is kept with the page it was started on, with its @names as pairs", () => {
    history.replaceState(null, "", "/playlist");
    const { carry, kept } = setup();
    carry.start();
    expect(kept().at(-1)?.draft).toMatchObject({ url: `${location.origin}/playlist`, text: "Broken here" });
    expect(kept().at(-1)?.draft?.picked).toEqual([["Ana", "u1"]]);
  });

  it("stays on its own page when a single-page site changes address, until it's back there", () => {
    history.replaceState(null, "", "/playlist");
    const { carry, kept } = setup();
    carry.start();
    const started = location.href;

    history.replaceState(null, "", "/album/7");
    expect(carry.moved(started, "p1", true)).toBe(true);
    expect(carry.from).toEqual({ url: started, projectId: "p1" });
    expect(kept().at(-1)?.draft?.url).toBe(started);

    history.replaceState(null, "", "/artist/3");
    expect(carry.moved(`${location.origin}/album/7`, "p1", true)).toBe(true);
    expect(carry.from?.url).toBe(started);

    history.replaceState(null, "", "/playlist");
    expect(carry.moved(`${location.origin}/artist/3`, "p1", true)).toBe(true);
    expect(carry.from).toBeNull();
  });

  it("lets the comment go with the old page when nothing is being recorded", () => {
    const { carry } = setup();
    expect(carry.moved(location.href, "p1", true)).toBe(false);
  });

  it("never replaces what's kept with nothing", () => {
    const { carry, kept } = setup(false);
    carry.start();
    carry.keepNow();
    expect(kept()).toEqual([]);
  });

  it("asks the background to let it go once it's saved or cancelled", () => {
    const { carry, fake } = setup();
    carry.start();
    carry.clear();
    expect(fake.sendMessage).toHaveBeenLastCalledWith({ type: "live.recorderClear" });
    expect(carry.active).toBe(false);
  });

  it("keeps only the parts of the address the comment's own page has", () => {
    expect(scopeFor("https://a.test/p?x=1", { query: true, hash: true })).toEqual({
      includeQuery: true,
      includeHash: false,
    });
  });
});

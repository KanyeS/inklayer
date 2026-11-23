import { describe, expect, it, vi } from "vitest";
import { INBOX_TEXT, inboxActor } from "../src/lib/inbox-text";
import { isOwnPage, type StateResponse, send } from "../src/lib/messages";
import { screenFor } from "../src/popup/browser";

describe("which popup screen shows", () => {
  const me = {} as NonNullable<StateResponse["me"]>;
  const state = (overrides: Partial<StateResponse>) =>
    ({ serverUrl: "https://ink.test", signedIn: true, me, ...overrides }) as StateResponse;

  it("sets up a server first", () => {
    expect(screenFor(state({ serverUrl: null }), "auto")).toBe("setup");
    expect(screenFor(state({ serverUrl: null }), "settings")).toBe("setup");
  });

  it("signs in, then shows the main screen", () => {
    expect(screenFor(state({ signedIn: false, me: null }), "auto")).toBe("signIn");
    expect(screenFor(state({ signedIn: true, me: null }), "auto")).toBe("signIn");
    expect(screenFor(state({}), "auto")).toBe("signedIn");
  });

  it("shows the screen the user picked", () => {
    expect(screenFor(state({}), "settings")).toBe("settings");
    expect(screenFor(state({}), "setup")).toBe("setup");
  });
});

describe("notification text", () => {
  it("says who did what", () => {
    expect(inboxActor({ kind: "mention", actor: { id: "1", displayName: "Bo", fullName: "Bo D" } })).toBe("Bo");
    expect(inboxActor({ kind: "reply", actor: null })).toBe("Someone");
    expect(inboxActor({ kind: "issue_closed", actor: { id: "1", displayName: "Bo", fullName: "Bo D" } })).toBeNull();
    expect(INBOX_TEXT.issue_closed).toBe("An issue for your comment was closed");
  });
});

describe("messages from the extension's own pages", () => {
  const root = "chrome-extension://abc/";

  it("knows the popup and the Improve setup page, also when one is open in a tab", () => {
    expect(isOwnPage(`${root}popup.html`, root)).toBe(true);
    expect(isOwnPage(`${root}improve.html`, root)).toBe(true);
  });

  it("never takes a web page (a content script's sender) for one of them", () => {
    expect(isOwnPage("https://site.example/improve.html", root)).toBe(false);
    expect(isOwnPage(`${root}recorder.html`, root)).toBe(false);
    expect(isOwnPage(undefined, root)).toBe(false);
  });

  it("says so when the background doesn't answer, rather than failing on nothing", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => undefined) } });
    await expect(send({ type: "state" })).rejects.toThrow("Inklayer didn't answer.");
    vi.unstubAllGlobals();
  });
});

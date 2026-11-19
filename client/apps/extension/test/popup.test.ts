import { describe, expect, it } from "vitest";
import { INBOX_TEXT, inboxActor } from "../src/lib/inbox-text";
import type { StateResponse } from "../src/lib/messages";
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

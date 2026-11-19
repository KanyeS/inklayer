import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fake SignalR hub per connection attempt; each test decides how its start() behaves. */
interface FakeHub {
  state: string;
  start: () => Promise<void>;
  stop: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  closeHandlers: ((error?: Error) => void)[];
}
const hubs: FakeHub[] = [];
let nextStart: (hub: FakeHub) => Promise<void> = () => Promise.resolve();

vi.mock("@microsoft/signalr", () => {
  class HubConnectionBuilder {
    withUrl() {
      return this;
    }
    configureLogging() {
      return this;
    }
    build() {
      const hub: FakeHub = {
        state: "Disconnected",
        start: () =>
          nextStart(hub).then(() => {
            hub.state = "Connected";
          }),
        stop: vi.fn(() => new Promise(() => undefined)), // like a hub whose socket is stuck: never settles
        invoke: vi.fn(() => Promise.resolve([])),
        closeHandlers: [],
      };
      hubs.push(hub);
      return {
        ...hub,
        get state() {
          return hub.state;
        },
        on: () => undefined,
        onclose: (h: () => void) => hub.closeHandlers.push(h),
        start: hub.start,
        stop: hub.stop,
        invoke: hub.invoke,
      };
    }
  }
  return {
    HubConnectionBuilder,
    HttpTransportType: { WebSockets: 1 },
    HubConnectionState: { Connected: "Connected" },
    LogLevel: { Warning: 3 },
  };
});
vi.mock("../src/lib/api", () => ({
  api: vi.fn(() => Promise.resolve({ liveCursors: true })),
  postJson: vi.fn(() => Promise.resolve({ ticket: "t" })),
}));
vi.mock("../src/lib/settings", () => ({
  getSettings: () => Promise.resolve({ serverUrl: "https://inklayer.example.com", tokens: null }),
}));

function fakePort() {
  const messages: unknown[] = [];
  let onMessage: (m: unknown) => void = () => undefined;
  const port = {
    sender: { id: "ext", tab: { id: 1 }, url: "https://site.example/page" },
    postMessage: (m: unknown) => messages.push(m),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (l: (m: unknown) => void) => {
        onMessage = l;
      },
    },
    onDisconnect: { addListener: () => undefined },
  };
  return { port: port as unknown as chrome.runtime.Port, messages, send: (m: unknown) => onMessage(m) };
}

/** Moves the fake clock on, letting pending promises run in between. */
async function wait(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

const statuses = (messages: unknown[]) =>
  messages.filter((m) => (m as { t: string }).t === "status").map((m) => (m as { status: string }).status);

describe("live cursors connection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hubs.length = 0;
    vi.stubGlobal("chrome", {
      runtime: { id: "ext" },
      storage: { session: { get: () => Promise.resolve({ presenceTabs: [1] }) } },
      action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
    });
    // The page hash: resolved right away, so only the fake clock decides timing.
    vi.stubGlobal("crypto", { subtle: { digest: () => Promise.resolve(new ArrayBuffer(32)) } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps a join the page sends before the background has checked the tab", async () => {
    const { acceptPort } = await import("../src/lib/presence");
    nextStart = () => Promise.resolve();
    const tab = fakePort();
    const accepting = acceptPort(tab.port); // still checking session storage...
    tab.send({ t: "join", url: "https://site.example/page" }); // ...when the page's join arrives, as in the browser
    await accepting;
    await wait(100);

    expect(hubs).toHaveLength(1);
    expect(statuses(tab.messages).at(-1)).toBe("live");
  });

  it("gives up on an attempt that never finishes and connects with a new one", async () => {
    const { acceptPort } = await import("../src/lib/presence");
    nextStart = () => new Promise(() => undefined); // the socket never opens or fails
    const tab = fakePort();
    await acceptPort(tab.port);
    tab.send({ t: "join", url: "https://site.example/page" });
    await wait(1_000);
    expect(hubs).toHaveLength(1);
    expect(statuses(tab.messages).at(-1)).toBe("connecting");

    nextStart = () => Promise.resolve();
    await wait(15_000); // the attempt times out, and the retry starts straight away

    expect(hubs).toHaveLength(2);
    expect(hubs[1]!.invoke).toHaveBeenCalledWith("Join", expect.any(String));
    expect(statuses(tab.messages).at(-1)).toBe("live");
  });

  it("starts a new connection when a live one drops", async () => {
    const { acceptPort } = await import("../src/lib/presence");
    nextStart = () => Promise.resolve();
    const tab = fakePort();
    await acceptPort(tab.port);
    tab.send({ t: "join", url: "https://site.example/page" });
    await wait(100);
    expect(statuses(tab.messages).at(-1)).toBe("live");

    hubs[0]!.state = "Disconnected";
    for (const close of hubs[0]!.closeHandlers) close(new Error("network changed"));
    await wait(100);

    expect(hubs).toHaveLength(2);
    expect(statuses(tab.messages).at(-1)).toBe("live");
  });
});

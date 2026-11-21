import { describe, expect, it, vi } from "vitest";

describe("page logs (capture.js)", () => {
  it("keeps console errors and failed requests without query strings, and answers when asked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 503 })),
    );
    await import("../src/capture-main");
    const silence = vi.spyOn(console, "log").mockImplementation(() => undefined);
    console.error("price is", undefined);
    await fetch("https://api.example.test/pay?token=secret", { method: "post" });

    const answer = new Promise<string>((resolve) =>
      document.addEventListener("inklayer:context-response", (e) => resolve(String((e as CustomEvent).detail)), {
        once: true,
      }),
    );
    document.dispatchEvent(new CustomEvent("inklayer:context-request", { detail: "n1" }));
    const logs = JSON.parse(await answer) as {
      nonce: string;
      console: { message: string }[];
      network: { method: string; url: string; status: number }[];
    };
    expect(logs.nonce).toBe("n1");
    expect(logs.console.at(-1)?.message).toBe("price is undefined");
    expect(logs.network.at(-1)).toMatchObject({ method: "POST", url: "https://api.example.test/pay", status: 503 });
    silence.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("typing in Inklayer on sites with keyboard shortcuts (capture.js)", () => {
  it("keeps plain characters typed in Inklayer from the page's shortcuts, and nothing else", async () => {
    await import("../src/capture-main");
    // The site's shortcut (YouTube's space for play/pause), listening on the way in, registered after capture.js.
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut, true);

    const panel = document.createElement("inklayer-live");
    const box = document.createElement("textarea");
    panel.attachShadow({ mode: "closed" }).append(box);
    const pageInput = document.createElement("input");
    document.body.append(panel, pageInput);
    const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init }),
      );

    press(box, " ");
    press(box, "k");
    expect(shortcut).not.toHaveBeenCalled();

    press(box, "Enter", { ctrlKey: true });
    press(box, "k", { ctrlKey: true });
    press(pageInput, " ");
    expect(shortcut).toHaveBeenCalledTimes(3);

    window.removeEventListener("keydown", shortcut, true);
    panel.remove();
    pageInput.remove();
  });
});

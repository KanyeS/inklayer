import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, followColorScheme, h, lineIcon, nothing, shadowTokens, stopPropagation } from "../src/dom";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("h", () => {
  it("creates an element with properties and children", () => {
    const onclick = vi.fn();
    const el = h("button", { className: "link", title: "Go", onclick }, "Open ", h("b", {}, "now"));
    expect(el.outerHTML).toBe('<button class="link" title="Go">Open <b>now</b></button>');
    el.click();
    expect(onclick).toHaveBeenCalledOnce();
  });

  it("sets styles, including custom properties", () => {
    const el = h("span", { style: { background: "red", "--c": "#123" } });
    expect(el.style.background).toBe("red");
    expect(el.style.getPropertyValue("--c")).toBe("#123");
  });

  it("skips empty children, so conditions can be written inline", () => {
    const el = h("p", {}, "a", null, undefined, false, "", "b");
    expect(el.childNodes).toHaveLength(2);
    expect(el.textContent).toBe("ab");
  });

  it("never parses markup in text", () => {
    const el = h("p", {}, "<img src=x onerror=alert(1)>");
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("small helpers", () => {
  it("makes an empty node", () => {
    const node = nothing();
    expect(node.nodeType).toBe(Node.TEXT_NODE);
    expect(node.textContent).toBe("");
  });

  it("stops a click reaching what's underneath", () => {
    const outer = vi.fn();
    const parent = h("div", { onclick: outer }, h("button", { onclick: stopPropagation }));
    (parent.firstChild as HTMLButtonElement).click();
    expect(outer).not.toHaveBeenCalled();
  });

  it("draws line icons from path data", () => {
    const svg = lineIcon(["M5 12h14", "M12 5v14"]);
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect([...svg.querySelectorAll("path")].map((p) => p.getAttribute("d"))).toEqual(["M5 12h14", "M12 5v14"]);
  });
});

describe("theme tokens in a shadow root", () => {
  it("scopes the page-wide tokens to the host", () => {
    const css = "/* theme */\n:root { --primary: blue; }\n.dark { --primary: navy; }\n.darkness {}";
    expect(shadowTokens(css)).toBe("\n:host { --primary: blue; }\n:host(.dark) { --primary: navy; }\n.darkness {}");
  });

  it("follows the system's dark mode", () => {
    let listener: () => void = () => undefined;
    const media = { matches: true, addEventListener: (_: string, l: () => void) => (listener = l) };
    vi.stubGlobal("matchMedia", () => media);
    const host = document.createElement("div");
    followColorScheme(host);
    expect(host.classList.contains("dark")).toBe(true);
    media.matches = false;
    listener();
    expect(host.classList.contains("dark")).toBe(false);
  });
});

describe("copying", () => {
  it("uses the clipboard when it can", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to a hidden text box without the clipboard API", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn(() => true);
    document.execCommand = execCommand;
    expect(await copyText("hello")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull(); // cleaned up
  });
});

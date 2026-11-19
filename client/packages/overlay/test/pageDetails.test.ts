import { describe, expect, it } from "vitest";
import { browserOf, elementHtml, osOf, screenshotArea } from "../src/pageDetails";

describe("screenshot area", () => {
  it("is the commented area plus a margin, at least a readable size, inside the window", () => {
    const viewport = { width: 1280, height: 800 };
    expect(screenshotArea({ x: 600, y: 400, width: 40, height: 20 }, viewport)).toEqual({
      x: 380,
      y: 260,
      width: 480,
      height: 300,
    });
    // Near the corner: kept inside the window.
    expect(screenshotArea({ x: 5, y: 5, width: 10, height: 10 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 480,
      height: 300,
    });
    // Bigger than the window: the whole window.
    expect(screenshotArea({ x: 0, y: 0, width: 2000, height: 2000 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    });
  });
});

describe("browser and OS", () => {
  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "Chrome 140",
      "macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      "Edge 140",
      "Windows",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0", "Firefox 145", "Linux"],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari 18",
      "iOS",
    ],
  ])("%s", (ua, browser, os) => {
    expect(browserOf(ua)).toBe(browser);
    expect(osOf(ua)).toBe(os);
  });
});

describe("element HTML", () => {
  it("leaves out what people typed, and scripts", () => {
    document.body.innerHTML = `<form id="f"><input name="card" value="4242 4242"><textarea>secret note</textarea><script>var k = "key";</script><button>Pay</button></form>`;
    const html = elementHtml(document.getElementById("f")!);
    expect(html).not.toContain("4242");
    expect(html).not.toContain("secret note");
    expect(html).not.toContain("key");
    expect(html).toContain("<button>Pay</button>");
  });
});

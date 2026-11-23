// @vitest-environment node
import { describe, expect, it } from "vitest";
import { webAddress } from "../src/browser";

describe("webAddress", () => {
  it("lets web pages through", () => {
    expect(webAddress("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(webAddress("http://localhost:5173")).toBe("http://localhost:5173/");
  });

  it("refuses local files and the browser's own pages", () => {
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "data:text/html,hi",
      "javascript:alert(1)",
      "view-source:https://a.com",
    ])
      expect(() => webAddress(url)).toThrow(/Only web pages/);
  });

  it("refuses what isn't an address", () => {
    expect(() => webAddress("example.com")).toThrow(/Not a web address/);
  });
});

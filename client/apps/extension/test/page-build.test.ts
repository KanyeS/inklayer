import { describe, expect, it } from "vitest";
import { pageScripts } from "../src/live/bug-context";

describe("page build", () => {
  const page = (html: string) => new DOMParser().parseFromString(html, "text/html");

  it("names the page's scripts, built files first, without addresses or queries", () => {
    const doc = page(`
      <script src="https://cdn.example/js/analytics.js?id=UA-1"></script>
      <script src="/assets/main.3f2a9c1e.js"></script>
      <script src="/assets/vendor-ab12cd34.js?v=2"></script>
      <script src="/assets/main.3f2a9c1e.js"></script>
      <script>inline()</script>`);
    expect(pageScripts(doc)).toEqual(["main.3f2a9c1e.js", "vendor-ab12cd34.js", "analytics.js"]);
  });

  it("puts a Next.js build id first", () => {
    const doc = page(`<script id="__NEXT_DATA__" type="application/json">{"buildId":"Xy12AbC"}</script>
      <script src="/_next/static/chunks/main-1a2b3c4d5e.js"></script>`);
    expect(pageScripts(doc)).toEqual(["next build Xy12AbC", "main-1a2b3c4d5e.js"]);
  });
});

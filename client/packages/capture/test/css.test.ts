import { describe, expect, it } from "vitest";
import { ResourceRegistry, rewriteCssUrls } from "../src";
import { NONCE, token } from "./helpers";

describe("rewriteCssUrls", () => {
  const base = "https://cdn.example/css/site.css";

  it("rewrites every url() form relative to the stylesheet", () => {
    const registry = new ResourceRegistry(NONCE);
    const css = `a{background:url(../img/a.png)} b{background:url('b.png')} c{background:url( "/c.png" )}`;

    const out = rewriteCssUrls(css, base, registry);

    expect(out).toBe(`a{background:url(${token(0)})} b{background:url(${token(1)})} c{background:url(${token(2)})}`);
    expect(registry.all.map((r) => r.url)).toEqual([
      "https://cdn.example/img/a.png", "https://cdn.example/css/b.png", "https://cdn.example/c.png",
    ]);
  });

  it("leaves data URLs and fragments alone, including ones with parentheses", () => {
    const registry = new ResourceRegistry(NONCE);
    const css = `a{background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0'/></svg>")} b{filter:url(#blur)}`;

    expect(rewriteCssUrls(css, base, registry)).toBe(css);
    expect(registry.all).toHaveLength(0);
  });

  it("registers the same URL once", () => {
    const registry = new ResourceRegistry(NONCE);

    rewriteCssUrls(`a{x:url(f.woff2)} b{y:url(./f.woff2)}`, base, registry);

    expect(registry.all).toHaveLength(1);
  });

  it("turns @import into inlinable placeholders, keeping media queries", () => {
    const registry = new ResourceRegistry(NONCE);

    const out = rewriteCssUrls(`@import url("theme.css");\n@import 'print.css' print;\nbody{}`, base, registry);

    expect(out).toBe(`${token(0)}\n@media print{${token(1)}}\nbody{}`);
    expect(registry.all.map((r) => [r.url, r.kind])).toEqual([
      ["https://cdn.example/css/theme.css", "css"], ["https://cdn.example/css/print.css", "css"],
    ]);
  });
});

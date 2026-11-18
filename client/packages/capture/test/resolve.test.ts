import { describe, expect, it } from "vitest";
import { resolveCapture, serializeDocument, sha256Hex, type FetchedResource } from "../src";
import { NONCE, page } from "./helpers";

const text = (s: string, contentType: string): FetchedResource => ({ bytes: new TextEncoder().encode(s), contentType });

describe("resolveCapture", () => {
  it("fetches resources, follows CSS into fonts and imports, and inlines the result", async () => {
    const doc = page(`<head><link rel="stylesheet" href="https://cdn.example/css/site.css"></head>
      <body><img src="/logo.png"><img src="/logo.png?dup=0" ></body>`);
    const serialized = await serializeDocument(doc, { nonce: NONCE });
    const files: Record<string, FetchedResource> = {
      "https://cdn.example/css/site.css": text(`@import "base.css";\n@font-face{src:url(../fonts/brand.woff2)}`, "text/css"),
      "https://cdn.example/css/base.css": text(`body{background:url(/bg.png)}`, "text/css"),
      "https://cdn.example/fonts/brand.woff2": text("FONT", "application/octet-stream"),
      "https://cdn.example/bg.png": text("BG", "image/png"),
      "https://shop.example/logo.png": text("LOGO", "image/png"),
      "https://shop.example/logo.png?dup=0": text("LOGO", "image/png"),
    };

    const result = await resolveCapture(serialized, async (url) => files[url] ?? null);
    const html = new TextDecoder().decode(result.document.bytes);

    const logo = await sha256Hex(new TextEncoder().encode("LOGO"));
    const font = await sha256Hex(new TextEncoder().encode("FONT"));
    const bg = await sha256Hex(new TextEncoder().encode("BG"));
    expect(html).toContain(`<img src="a/${logo}">`);
    expect(html).toContain(`body{background:url(a/${bg})}`);
    expect(html).toContain(`@font-face{src:url(a/${font})}`);
    expect(html).not.toMatch(/ilr-/);
    expect(result.failed).toEqual([]);
    // Identical bytes are stored once, and generic content types are corrected from the file extension.
    expect(result.assets.map((a) => [a.hash, a.contentType]).sort()).toEqual(
      [[logo, "image/png"], [font, "font/woff2"], [bg, "image/png"]].sort());
    expect(result.document.hash).toBe(await sha256Hex(result.document.bytes));
  });

  it("keeps going when resources fail, and reports them", async () => {
    const doc = page(`<body><img src="/missing.png"><p>Still here</p></body>`);
    const serialized = await serializeDocument(doc, { nonce: NONCE });

    const result = await resolveCapture(serialized, async () => null);
    const html = new TextDecoder().decode(result.document.bytes);

    expect(result.failed).toEqual(["https://shop.example/missing.png"]);
    expect(html).toContain('<img src="about:invalid">');
    expect(html).toContain("<p>Still here</p>");
  });

  it("stops following imports that loop", async () => {
    const doc = page(`<head><link rel="stylesheet" href="https://cdn.example/a.css"></head><body></body>`);
    const serialized = await serializeDocument(doc, { nonce: NONCE });
    const files: Record<string, FetchedResource> = {
      "https://cdn.example/a.css": text(`@import "b.css"; .a{}`, "text/css"),
      "https://cdn.example/b.css": text(`@import "a.css"; .b{}`, "text/css"),
    };

    const result = await resolveCapture(serialized, async (url) => files[url] ?? null);
    const html = new TextDecoder().decode(result.document.bytes);

    expect(html).toContain(".a{}");
    expect(html).toContain(".b{}");
    expect(html).not.toMatch(/ilr-/);
  });

  it("escapes fetched CSS so it can't close the <style> element", async () => {
    const doc = page(`<head><link rel="stylesheet" href="https://cdn.example/evil.css"></head><body></body>`);
    const serialized = await serializeDocument(doc, { nonce: NONCE });

    const result = await resolveCapture(serialized, async () => text(`.x{content:"</style><script>alert(1)</script>"}`, "text/css"));

    expect(new TextDecoder().decode(result.document.bytes)).not.toContain("</style><script>");
  });
});

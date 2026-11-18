import { describe, expect, it } from "vitest";
import { serializeDocument } from "../src";
import { NONCE, page, token } from "./helpers";

const serialize = (doc: Document, options = {}) => serializeDocument(doc, { nonce: NONCE, ...options });

describe("serializeDocument", () => {
  it("keeps content and drops scripts and event handlers", async () => {
    const doc = page(`<html><head><title>Shop</title><script>track()</script></head>
      <body onload="init()"><h1 class="hero" onclick="x()">Deals &amp; offers</h1><noscript>Enable JS</noscript>
      <button onmouseover="y()">Buy</button></body></html>`);

    const { html, meta } = await serialize(doc);

    expect(html.startsWith("<!DOCTYPE html>\n<html>")).toBe(true);
    expect(html).toContain('<h1 class="hero">Deals &amp; offers</h1>');
    expect(html).toContain("<button>Buy</button>");
    expect(html).not.toMatch(/script|onload|onclick|onmouseover|Enable JS/);
    expect(meta.title).toBe("Shop");
    expect(meta.url).toBe("https://shop.example/products/item.html");
  });

  it("replaces images with placeholders resolved against the page URL", async () => {
    const doc = page(`<body><img src="../img/logo.png" srcset="logo@2x.png 2x" loading="lazy" alt="Logo">
      <img src="data:image/png;base64,AAAA"><img src="javascript:alert(1)"></body>`);

    const { html, resources } = await serialize(doc);

    expect(resources).toEqual([{ token: token(0), url: "https://shop.example/img/logo.png", kind: "binary" }]);
    expect(html).toContain(`<img src="${token(0)}" alt="Logo">`);
    expect(html).toContain('<img src="data:image/png;base64,AAAA">');
    expect(html).toContain('<img src="">');
    expect(html).not.toContain("srcset");
  });

  it("makes links absolute but does not fetch them", async () => {
    const doc = page(`<body><a href="/about">About</a><a href="javascript:alert(1)">Bad</a><a href="mailto:a@b.c">Mail</a></body>`);

    const { html, resources } = await serialize(doc);

    expect(html).toContain('<a href="https://shop.example/about">About</a>');
    expect(html).toContain('<a href="">Bad</a>');
    expect(html).toContain('<a href="mailto:a@b.c">Mail</a>');
    expect(resources).toHaveLength(0);
  });

  it("captures what was typed into form fields, but never passwords", async () => {
    const doc = page(`<body><input id="q" value="original"><input type="password" id="pw" value="secret">
      <input type="checkbox" id="cb"><textarea id="t">old</textarea>
      <select id="s"><option>One</option><option>Two</option></select></body>`);
    (doc.getElementById("q") as HTMLInputElement).value = "typed search";
    (doc.getElementById("pw") as HTMLInputElement).value = "hunter2";
    (doc.getElementById("cb") as HTMLInputElement).checked = true;
    (doc.getElementById("t") as HTMLTextAreaElement).value = "new <text>";
    (doc.getElementById("s") as HTMLSelectElement).selectedIndex = 1;

    const { html } = await serialize(doc);

    expect(html).toContain('value="typed search"');
    expect(html).not.toMatch(/secret|hunter2/);
    expect(html).toMatch(/<input type="checkbox" id="cb" checked="">/);
    expect(html).toContain("<textarea id=\"t\">new &lt;text&gt;</textarea>");
    expect(html).toContain("<option>One</option><option selected=\"\">Two</option>");
  });

  it("masks text and values inside elements matching the mask selector", async () => {
    const doc = page(`<body><div class="pii">Jane Doe <input value="jane@example.com"></div><p>Public</p></body>`);

    const { html } = await serialize(doc, { maskSelector: ".pii" });

    expect(html).not.toMatch(/Jane|jane@example/);
    expect(html).toContain("•••• •••");
    expect(html).toContain("<p>Public</p>");
  });

  it("writes shadow DOM out as declarative shadow roots", async () => {
    const doc = page(`<body><x-card id="host"><span slot="title">Light</span></x-card></body>`);
    const shadow = doc.getElementById("host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>p{color:red}</style><p>Inside <slot name="title"></slot></p>`;

    const { html } = await serialize(doc);

    expect(html).toMatch(/<x-card id="host"><template shadowrootmode="open"><style>p \{\s*color: red;\s*\}/);
    expect(html).toContain('<p>Inside <slot name="title"></slot></p></template><span slot="title">Light</span></x-card>');
  });

  it("captures closed shadow roots when given a way to reach them", async () => {
    const doc = page(`<body><x-secret id="host"></x-secret></body>`);
    const closed = doc.getElementById("host")!.attachShadow({ mode: "closed" });
    closed.innerHTML = "<b>closed content</b>";

    const { html } = await serialize(doc, { getShadowRoot: (el: Element) => (el.id === "host" ? closed : null) });

    expect(html).toContain('<template shadowrootmode="open"><b>closed content</b></template>');
  });

  it("turns frames and plugins into sized placeholders", async () => {
    const doc = page(`<body><iframe id="video" src="https://video.example/embed"></iframe><embed src="x.swf"></body>`);

    const { html, resources } = await serialize(doc);

    expect(html).toContain('id="video"');
    expect(html).toContain('data-inklayer-embed="iframe"');
    expect(html).toContain('data-inklayer-embed="embed"');
    expect(html).not.toContain("video.example");
    expect(resources).toHaveLength(0);
  });

  it("reads inline styles through the CSSOM and rewrites their URLs", async () => {
    const doc = page(`<head><style>.hero { background: url("../img/bg.jpg"); }</style></head>
      <body><div style="background-image:url(/img/tile.png)">x</div></body>`);
    // Rules added by CSS-in-JS libraries exist only in the CSSOM, not in the <style> text.
    (doc.querySelector("style")!.sheet as CSSStyleSheet).insertRule(".added { color: blue; }", 1);

    const { html, resources } = await serialize(doc);

    expect(resources.map((r) => r.url)).toEqual(["https://shop.example/img/bg.jpg", "https://shop.example/img/tile.png"]);
    expect(html).toContain(`url(${token(0)})`);
    expect(html).toMatch(/\.added \{\s*color: blue;\s*\}/);
    expect(html).toContain(`style="background-image:url(${token(1)})"`);
  });

  it("queues external stylesheets that can't be read for fetching", async () => {
    const doc = page(`<head><link rel="stylesheet" href="https://cdn.example/site.css" media="print">
      <link rel="icon" href="/favicon.ico"><link rel="preload" href="/font.woff2"></head><body></body>`);

    const { html, resources } = await serialize(doc);

    expect(resources).toEqual([{ token: token(0), url: "https://cdn.example/site.css", kind: "css" }]);
    expect(html).toContain(`<style>@media print{${token(0)}}</style>`);
    expect(html).not.toContain("favicon");
    expect(html).not.toContain("<link");
  });

  it("keeps SVG markup and case-sensitive names", async () => {
    const doc = page(`<body><svg viewBox="0 0 10 10"><defs><linearGradient id="g"></linearGradient></defs>
      <use href="/sprite.svg#icon"></use><use href="#g"></use></svg></body>`);

    const { html, resources } = await serialize(doc);

    expect(html).toContain('<svg viewBox="0 0 10 10">');
    expect(html).toContain('<linearGradient id="g"></linearGradient>');
    expect(html).toContain(`<use href="${token(0)}#icon"></use>`);
    expect(html).toContain('<use href="#g"></use>');
    expect(resources[0]!.url).toBe("https://shop.example/sprite.svg");
  });

  it("escapes text and attribute values", async () => {
    const doc = page(`<body><p title='say "hi" & <bye>'>1 &lt; 2</p></body>`);

    const { html } = await serialize(doc);

    expect(html).toContain('<p title="say &quot;hi&quot; &amp; &lt;bye&gt;">1 &lt; 2</p>');
  });

  it("can't be broken out of a <style> by CSS text", async () => {
    const doc = page(`<head><style id="s"></style></head><body></body>`);
    doc.getElementById("s")!.textContent = `.a::after { content: "</style><script>alert(1)</script>"; }`;

    const { html } = await serialize(doc);

    expect(html).not.toContain("</style><script>");
  });
});

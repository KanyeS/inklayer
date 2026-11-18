import { escapeStyleText, rewriteCssUrls } from "./css";
import { ResourceRegistry, createNonce, resolveFetchableUrl, type ResourceRef } from "./resources";

export interface PageMeta {
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  userAgent: string;
}

export interface SerializedPage {
  /** Static HTML with resource placeholders (see {@link ResourceRegistry}). */
  html: string;
  resources: ResourceRef[];
  /** Placeholder pattern source, for the step that substitutes fetched resources. */
  nonce: string;
  meta: PageMeta;
}

export interface SerializeOptions {
  /** Defaults to a random nonce. */
  nonce?: string;
  /**
   * Returns an element's shadow root, including closed ones. In an extension, pass
   * `(el) => chrome.dom.openOrClosedShadowRoot(el)`; by default only open roots are captured.
   */
  getShadowRoot?: (element: Element) => ShadowRoot | null;
  /** Text and form values inside elements matching this selector are replaced with "•" (for personal data). */
  maskSelector?: string;
}

const HTML_NS = "http://www.w3.org/1999/xhtml";
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);
const DROPPED_ELEMENTS = new Set(["script", "noscript", "template", "base", "slot-fallback"]);
const EMBEDDED_ELEMENTS = new Set(["iframe", "frame", "object", "embed", "portal", "fencedframe"]);
const DROPPED_ATTRIBUTES = new Set(["srcset", "sizes", "nonce", "integrity", "loading", "imagesrcset", "imagesizes", "srcdoc"]);
const SVG_RESOURCE_ELEMENTS = new Set(["image", "use", "feImage"]);
const MASK = "•";

/**
 * Turns the live document into one static HTML string that looks like what the user sees:
 * <ul>
 * <li>Form fields keep what was typed. Password fields are never captured.</li>
 * <li>Styles come from the CSSOM, so CSS-in-JS and <code>insertRule</code> changes are kept, along with constructed/adopted stylesheets.</li>
 * <li>Shadow DOM is written out as declarative shadow DOM (<code>&lt;template shadowrootmode&gt;</code>).</li>
 * <li>Canvases become images. Frames and plugins become sized placeholders.</li>
 * <li>Scripts and event handlers are dropped.</li>
 * </ul>
 * Each external file the page uses (images, fonts, stylesheets that can't be read) is replaced by a placeholder and
 * listed in `resources`, so the caller can fetch it with extension privileges.
 */
export async function serializeDocument(doc: Document, options: SerializeOptions = {}): Promise<SerializedPage> {
  const registry = new ResourceRegistry(options.nonce ?? createNonce());
  const serializer = new Serializer(doc, registry, options);
  const html = await serializer.serializeDocument();
  const win = doc.defaultView;
  return {
    html,
    resources: registry.all,
    nonce: registry.nonce,
    meta: {
      url: doc.URL,
      title: doc.title,
      viewportWidth: win?.innerWidth ?? 0,
      viewportHeight: win?.innerHeight ?? 0,
      devicePixelRatio: win?.devicePixelRatio ?? 1,
      scrollX: Math.round(win?.scrollX ?? 0),
      scrollY: Math.round(win?.scrollY ?? 0),
      userAgent: win?.navigator.userAgent ?? "",
    },
  };
}

class Serializer {
  readonly #doc: Document;
  readonly #registry: ResourceRegistry;
  readonly #options: SerializeOptions;
  readonly #masked = new WeakSet<Element>();

  constructor(doc: Document, registry: ResourceRegistry, options: SerializeOptions) {
    this.#doc = doc;
    this.#registry = registry;
    this.#options = options;
    if (options.maskSelector) {
      for (const el of doc.querySelectorAll(options.maskSelector)) this.#masked.add(el);
    }
  }

  async serializeDocument(): Promise<string> {
    const root = this.#doc.documentElement;
    return `<!DOCTYPE html>\n${await this.#element(root, false)}`;
  }

  async #children(parent: ParentNode, masked: boolean): Promise<string> {
    let out = "";
    for (const child of parent.childNodes) {
      out += await this.#node(child, masked);
    }
    return out;
  }

  async #node(node: Node, masked: boolean): Promise<string> {
    switch (node.nodeType) {
      case 1: // ELEMENT_NODE
        return this.#element(node as Element, masked);
      case 3: { // TEXT_NODE
        const text = node.textContent ?? "";
        return escapeText(masked ? maskText(text) : text);
      }
      default:
        return ""; // comments, processing instructions
    }
  }

  async #element(el: Element, parentMasked: boolean): Promise<string> {
    const name = el.localName;
    const isHtml = el.namespaceURI === HTML_NS;
    const masked = parentMasked || this.#masked.has(el);

    if (isHtml && DROPPED_ELEMENTS.has(name)) return "";
    if (isHtml && name === "meta" && el.hasAttribute("http-equiv")) return "";
    if (isHtml && EMBEDDED_ELEMENTS.has(name)) return this.#placeholder(el);
    if (isHtml && name === "link") return this.#link(el as HTMLLinkElement);
    if (isHtml && name === "style") return this.#styleElement(el as HTMLStyleElement);
    if (isHtml && name === "canvas") return this.#canvas(el as HTMLCanvasElement);

    const tag = isHtml ? name : el.tagName;
    let out = `<${tag}${await this.#attributes(el, masked)}>`;
    if (isHtml && VOID_ELEMENTS.has(name)) return out;

    const shadow = this.#options.getShadowRoot?.(el) ?? el.shadowRoot;
    if (shadow) {
      out += `<template shadowrootmode="open">${this.#adoptedStyles(shadow)}${await this.#children(shadow, masked)}</template>`;
    }

    if (isHtml && name === "textarea") {
      const value = (el as HTMLTextAreaElement).value;
      out += escapeText(masked ? maskText(value) : value);
    } else {
      out += await this.#children(el, masked);
    }

    if (isHtml && name === "head") out += this.#adoptedStyles(this.#doc);
    return `${out}</${tag}>`;
  }

  async #attributes(el: Element, masked: boolean): Promise<string> {
    const name = el.localName;
    const isHtml = el.namespaceURI === HTML_NS;
    const base = el.baseURI || this.#doc.baseURI;
    const attrs = new Map<string, string | null>();

    for (const attr of el.attributes) {
      const attrName = attr.name;
      const lower = attrName.toLowerCase();
      if (lower.startsWith("on") || DROPPED_ATTRIBUTES.has(lower)) continue;
      attrs.set(attrName, attr.value);
    }

    if (attrs.has("style")) attrs.set("style", rewriteCssUrls(attrs.get("style") ?? "", base, this.#registry));

    // Tag-name checks rather than instanceof, so elements from other windows (same-origin frames, tests) work too.
    if (isHtml && name === "img") {
      const img = el as HTMLImageElement;
      attrs.set("src", await this.#binaryUrl(img.currentSrc || img.getAttribute("src"), base));
    } else if (isHtml && name === "input") {
      this.#inputState(el as HTMLInputElement, attrs, masked, base);
    } else if (isHtml && name === "option") {
      if ((el as HTMLOptionElement).selected) attrs.set("selected", ""); else attrs.delete("selected");
    } else if (isHtml && name === "video") {
      attrs.delete("src");
      const poster = el.getAttribute("poster");
      if (poster) attrs.set("poster", await this.#binaryUrl(poster, base));
    } else if (isHtml && (name === "a" || name === "area")) {
      const href = el.getAttribute("href");
      if (href !== null) attrs.set("href", absoluteLink(href, base));
    } else if (isHtml && (name === "source" || name === "audio" || name === "track")) {
      attrs.delete("src");
    } else if (!isHtml && SVG_RESOURCE_ELEMENTS.has(el.tagName)) {
      for (const key of ["href", "xlink:href"]) {
        const value = attrs.get(key);
        if (value && !value.startsWith("#")) attrs.set(key, await this.#svgReference(value, base));
      }
    }

    if (isHtml && (name === "body" || name === "table" || name === "td")) {
      const background = attrs.get("background");
      if (background) attrs.set("background", await this.#binaryUrl(background, base));
    }

    let out = "";
    for (const [attrName, value] of attrs) {
      out += value === null ? "" : ` ${attrName}="${escapeAttribute(value)}"`;
    }
    return out;
  }

  #inputState(el: HTMLInputElement, attrs: Map<string, string | null>, masked: boolean, base: string): void {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "password") {
      attrs.delete("value");
    } else if (type === "checkbox" || type === "radio") {
      if (el.checked) attrs.set("checked", ""); else attrs.delete("checked");
    } else if (type === "image") {
      attrs.set("src", this.#registerOrBlank(el.getAttribute("src"), base));
    } else if (type !== "file" && type !== "hidden") {
      attrs.set("value", masked ? maskText(el.value) : el.value);
    }
  }

  async #binaryUrl(raw: string | null, base: string): Promise<string> {
    const value = raw?.trim() ?? "";
    if (value.startsWith("data:image/")) return value;
    if (value.startsWith("blob:")) return (await blobToDataUrl(value)) ?? "";
    return this.#registerOrBlank(value, base);
  }

  #registerOrBlank(raw: string | null, base: string): string {
    const url = resolveFetchableUrl(raw, base);
    return url ? this.#registry.register(url, "binary") : "";
  }

  async #svgReference(raw: string, base: string): Promise<string> {
    // External sprite references keep their fragment: sprite.svg#icon -> a/<hash>#icon
    const hashIndex = raw.indexOf("#");
    const file = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const fragment = hashIndex >= 0 ? raw.slice(hashIndex) : "";
    const token = await this.#binaryUrl(file, base);
    return token ? token + fragment : "";
  }

  #link(link: HTMLLinkElement): string {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet") || link.disabled) return "";
    const media = link.media && link.media !== "all" ? link.media : "";
    const css = this.#readSheet(link.sheet, link.href) ?? this.#registerCss(link.href);
    return css === null ? "" : `<style>${escapeStyleText(wrapMedia(css, media))}</style>`;
  }

  #styleElement(style: HTMLStyleElement): string {
    const base = style.baseURI || this.#doc.baseURI;
    const css = this.#readSheet(style.sheet, base) ?? rewriteCssUrls(style.textContent ?? "", base, this.#registry);
    const media = style.media && style.media !== "all" ? ` media="${escapeAttribute(style.media)}"` : "";
    return `<style${media}>${escapeStyleText(css)}</style>`;
  }

  #registerCss(href: string): string | null {
    const url = resolveFetchableUrl(href, this.#doc.baseURI);
    return url ? this.#registry.register(url, "css") : null;
  }

  /** Reads a stylesheet through the CSSOM. Returns null when the browser won't allow it (a cross-origin sheet without CORS). */
  #readSheet(sheet: CSSStyleSheet | null, baseUrl: string): string | null {
    if (!sheet) return null;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return null;
    }

    let out = "";
    for (const rule of rules) {
      if (rule.constructor.name === "CSSImportRule" || rule.type === 3 /* IMPORT_RULE */) {
        const importRule = rule as CSSImportRule;
        const href = resolveFetchableUrl(importRule.href, baseUrl) ?? importRule.href;
        const inner = this.#readSheet(importRule.styleSheet, href) ?? this.#registerCss(href);
        const media = importRule.media?.mediaText ?? "";
        if (inner !== null) out += wrapMedia(inner, media && media !== "all" ? media : "");
        continue;
      }
      out += rewriteCssUrls(rule.cssText, baseUrl, this.#registry) + "\n";
    }
    return out;
  }

  #adoptedStyles(root: Document | ShadowRoot): string {
    const sheets = (root as { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? [];
    let out = "";
    for (const sheet of sheets) {
      const css = this.#readSheet(sheet, this.#doc.baseURI);
      if (css) out += `<style>${escapeStyleText(css)}</style>`;
    }
    return out;
  }

  #canvas(canvas: HTMLCanvasElement): string {
    let dataUrl = "";
    try {
      dataUrl = canvas.toDataURL("image/png");
    } catch {
      // A canvas that drew cross-origin images is "tainted" and can't be read; leave an empty box of the same size.
    }
    const attrs = keepAttributes(canvas, ["id", "class", "style", "width", "height"]);
    return `<img${attrs}${dataUrl.startsWith("data:image/") ? ` src="${escapeAttribute(dataUrl)}"` : ""} data-inklayer-canvas="">`;
  }

  #placeholder(el: Element): string {
    const rect = el.getBoundingClientRect();
    const attrs = keepAttributes(el, ["id", "class"]);
    const style = `display:inline-block;box-sizing:border-box;width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;` +
      "background:repeating-linear-gradient(45deg,#f3f4f6,#f3f4f6 10px,#e5e7eb 10px,#e5e7eb 20px);border:1px dashed #9ca3af;" +
      "color:#4b5563;font:12px/1.4 system-ui,sans-serif;padding:8px;overflow:hidden";
    return `<div${attrs} style="${style}" data-inklayer-embed="${escapeAttribute(el.localName)}">Embedded content (${escapeText(el.localName)}) was not captured</div>`;
  }
}

function keepAttributes(el: Element, names: string[]): string {
  let out = "";
  for (const name of names) {
    const value = el.getAttribute(name);
    if (value !== null) out += ` ${name}="${escapeAttribute(value)}"`;
  }
  return out;
}

function wrapMedia(css: string, media: string): string {
  return media ? `@media ${media}{${css}}` : css;
}

function absoluteLink(href: string, base: string): string {
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : "";
  } catch {
    return "";
  }
}

async function blobToDataUrl(url: string): Promise<string | null> {
  try {
    const blob = await (await fetch(url)).blob();
    if (!blob.type.startsWith("image/") || blob.size > 2 * 1024 * 1024) return null;
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function maskText(text: string): string {
  return text.replace(/\S/g, MASK);
}

export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

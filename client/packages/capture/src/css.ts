import { resolveFetchableUrl, type ResourceRegistry } from "./resources";

// url(x), url('x'), url("x"); quoted values may contain parentheses (e.g. data: URIs).
const URL_PATTERN = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)"'\s]*))\s*\)/gi;
// @import "x.css" screen;  @import url(x.css) print;
const IMPORT_PATTERN = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^)"'\s;]+))\s*\)?\s*([^;]*);/gi;

/**
 * Rewrites every external `url()` in a stylesheet to a resource placeholder, resolving relative URLs against
 * `baseUrl` (the stylesheet's own URL, or the document's for inline CSS). `@import`s become CSS placeholders,
 * wrapped in `@media` when the import had a media query, so the imported text can be inlined in place.
 * `data:` URLs and `#fragment` references are left as they are.
 */
export function rewriteCssUrls(css: string, baseUrl: string, registry: ResourceRegistry): string {
  const withImports = css.replace(IMPORT_PATTERN, (match, dq: string | undefined, sq: string | undefined, bare: string | undefined, media: string) => {
    const url = resolveFetchableUrl(dq ?? sq ?? bare, baseUrl);
    if (!url) return match;
    const token = registry.register(url, "css");
    const condition = media.trim();
    return condition ? `@media ${condition}{${token}}` : token;
  });

  return withImports.replace(URL_PATTERN, (match, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
    const raw = unescapeCss(dq ?? sq ?? bare ?? "");
    if (raw.startsWith(`ilr-${registry.nonce}-`)) return match; // already a placeholder (e.g. an inlined @import)
    const url = resolveFetchableUrl(raw, baseUrl);
    if (!url) return match;
    return `url(${registry.register(url, "binary")})`;
  });
}

function unescapeCss(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

/** Makes CSS text safe to place inside a `<style>` element. */
export function escapeStyleText(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

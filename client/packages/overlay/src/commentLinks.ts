/**
 * Links between page comments and docs, shared by the extension panel and the viewer.
 * <ul>
 * <li>A comment can link docs by writing <code>[[Doc title]]</code> (or <code>[[Folder/Title]]</code>, with <code>#heading</code>
 * and <code>|shown text</code>, as in docs).</li>
 * <li>"Open on the page" goes to the page with a hidden fragment directive, <code>#:~:inklayer=comment:&lt;id&gt;</code>. Browsers
 * keep <code>:~:</code> directives away from the page's own scripts, so the site's routing isn't disturbed; the extension
 * reads it and opens that comment.</li>
 * </ul>
 */

export type CommentPart = { text: string } | { link: string; shown: string; docId: string | null };

/** Splits a comment body into text and [[links]], with the doc each link opens (from the server's docLinks). */
export function commentParts(body: string, docLinks: { text: string; docId: string | null }[] = []): CommentPart[] {
  const parts: CommentPart[] = [];
  const byKey = new Map(docLinks.map((l) => [l.text.toLowerCase(), l.docId]));
  let last = 0;
  for (const m of body.matchAll(/\[\[([^[\]\n]+?)\]\]/g)) {
    let inner = m[1]!;
    let alias: string | null = null;
    const pipe = inner.indexOf("|");
    if (pipe >= 0) {
      alias = inner.slice(pipe + 1).trim() || null;
      inner = inner.slice(0, pipe);
    }
    const hash = inner.indexOf("#");
    const target = (hash >= 0 ? inner.slice(0, hash) : inner).split("/").map((s) => s.trim()).filter(Boolean).join("/");
    if (!target || target.toLowerCase().startsWith("comment:")) continue;
    if (m.index > last) parts.push({ text: body.slice(last, m.index) });
    parts.push({ link: target, shown: alias ?? inner.trim(), docId: byKey.get(target.toLowerCase()) ?? null });
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts;
}

const DIRECTIVE = "inklayer=comment:";

/** The page's address with the directive that tells the extension to open this comment. */
export function openOnPageUrl(pageUrl: string, commentId: string): string {
  const url = new URL(pageUrl);
  return `${url.href}${url.hash ? "" : "#"}:~:${DIRECTIVE}${encodeURIComponent(commentId)}`;
}

/**
 * The comment a page was opened for, if any. Browsers hide fragment directives from <code>location</code>, so this reads
 * the navigation entry, which keeps the address as requested; where the browser leaves it in <code>location</code>, that
 * works too.
 */
export function commentToOpen(locationHref: string, navigationName: string | undefined): string | null {
  for (const candidate of [navigationName, locationHref]) {
    const at = candidate?.indexOf(`:~:${DIRECTIVE}`) ?? -1;
    if (at < 0) continue;
    const value = decodeURIComponent(candidate!.slice(at + 3 + DIRECTIVE.length).split(/[&#]/)[0]!);
    if (/^[0-9a-f-]{36}$/i.test(value)) return value.toLowerCase();
  }
  return null;
}

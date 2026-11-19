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

export type CommentPart =
  | { text: string }
  | { link: string; shown: string; docId: string | null }
  | { mention: string; userId: string; fullName: string | null };

/** Someone who can be @mentioned: the name they're shown as, and their real name (for hover). */
export interface MentionPerson {
  id: string;
  displayName: string;
  fullName?: string | null;
}

/** <@user-id>: an @mention, stored by id and shown as the person's name. */
export const MENTION_PATTERN = /<@([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>/g;

/**
 * Splits a comment body into text, [[links]] (with the doc each opens, from the server's docLinks) and @mentions (with
 * names, from the server's people).
 */
export function commentParts(
  body: string,
  docLinks: { text: string; docId: string | null }[] = [],
  people: MentionPerson[] = [],
): CommentPart[] {
  return linkParts(body, docLinks).flatMap((part) => ("text" in part ? mentionParts(part.text, people) : [part]));
}

/** Text with its @mentions as separate parts. */
export function mentionParts(text: string, people: MentionPerson[]): CommentPart[] {
  const byId = new Map(people.map((p) => [p.id.toLowerCase(), p]));
  const parts: CommentPart[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_PATTERN)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    const person = byId.get(m[1]!.toLowerCase());
    parts.push({
      mention: person?.displayName ?? "someone",
      userId: m[1]!.toLowerCase(),
      fullName: person?.fullName ?? null,
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Turns @Name back into <@id> for the people picked while typing, before saving. */
export function encodeMentions(text: string, picked: Map<string, string>): string {
  let result = text;
  // Longest names first, so "@Ana Lee" isn't taken for "@Ana".
  for (const [name, id] of [...picked].sort((a, b) => b[0].length - a[0].length))
    result = result.split(`@${name}`).join(`<@${id}>`);
  return result;
}

/** Shows <@id> as @Name for editing, remembering who's who so it can be saved back. */
export function decodeMentions(text: string, people: MentionPerson[], picked: Map<string, string>): string {
  const byId = new Map(people.map((p) => [p.id.toLowerCase(), p]));
  return text.replace(MENTION_PATTERN, (whole, id: string) => {
    const person = byId.get(id.toLowerCase());
    if (!person) return whole;
    picked.set(person.displayName, person.id);
    return `@${person.displayName}`;
  });
}

function linkParts(body: string, docLinks: { text: string; docId: string | null }[]): CommentPart[] {
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
    const target = (hash >= 0 ? inner.slice(0, hash) : inner)
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean)
      .join("/");
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

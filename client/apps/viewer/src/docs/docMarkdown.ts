/**
 * Links and tags in docs, with the same rules as the server (DocMarkdown.cs):
 * <ul>
 * <li><code>[[Title]]</code>, <code>[[Folder/Title]]</code>, <code>[[Title#Heading]]</code>, <code>[[Title|shown text]]</code>, <code>![[embed]]</code></li>
 * <li><code>[[comment:&lt;id&gt;]]</code> links a page comment</li>
 * <li><code>#tag</code> at the start of a line or after a space; not headings, not all digits</li>
 * </ul>
 * Nothing in fenced code blocks or inline code counts.
 */

export interface WikiLink {
  /** The doc as written, e.g. "Roadmap" or "Research/Interviews". Null for comment links. */
  target: string | null;
  heading: string | null;
  alias: string | null;
  commentId: string | null;
  embed: boolean;
  /** Where the whole [[…]] is in the text. */
  from: number;
  to: number;
}

export const LINK_PATTERN = /(!)?\[\[([^[\]\n]+?)\]\]/g;
const TAG_PATTERN = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const COMMENT_PREFIX = "comment:";

export function parseLink(inner: string, embed: boolean, from: number, to: number): WikiLink | null {
  let alias: string | null = null;
  const pipe = inner.indexOf("|");
  if (pipe >= 0) {
    alias = inner.slice(pipe + 1).trim() || null;
    inner = inner.slice(0, pipe);
  }
  inner = inner.trim();
  if (inner.toLowerCase().startsWith(COMMENT_PREFIX)) {
    const id = inner.slice(COMMENT_PREFIX.length).trim();
    return GUID.test(id) ? { target: null, heading: null, alias, commentId: id.toLowerCase(), embed, from, to } : null;
  }
  let heading: string | null = null;
  const hash = inner.indexOf("#");
  if (hash >= 0) {
    heading = inner.slice(hash + 1).trim() || null;
    inner = inner.slice(0, hash).trim();
  }
  if (!inner) return null;
  let target = inner.split("/").map((p) => p.trim()).filter(Boolean).join("/");
  if (target.toLowerCase().endsWith(".md")) target = target.slice(0, -3);
  return target ? { target, heading, alias, commentId: null, embed, from, to } : null;
}

/** Ranges of the text that are code (fenced blocks and inline code), where links and tags don't count. */
export function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let fence: { marker: string; start: number } | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (!fence && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      fence = { marker: trimmed.slice(0, 3), start: offset };
    } else if (fence && trimmed.startsWith(fence.marker)) {
      ranges.push([fence.start, offset + line.length]);
      fence = null;
    } else if (!fence) {
      for (const m of line.matchAll(/(`+)[^`]*?\1/g)) ranges.push([offset + m.index, offset + m.index + m[0].length]);
    }
    offset += line.length + 1;
  }
  if (fence) ranges.push([fence.start, text.length]);
  return ranges;
}

const inside = (ranges: [number, number][], at: number) => ranges.some(([a, b]) => at >= a && at < b);

export function extractLinks(text: string): WikiLink[] {
  const code = codeRanges(text);
  const links: WikiLink[] = [];
  for (const m of text.matchAll(LINK_PATTERN)) {
    if (inside(code, m.index)) continue;
    const link = parseLink(m[2]!, Boolean(m[1]), m.index, m.index + m[0].length);
    if (link) links.push(link);
  }
  return links;
}

export function extractTags(text: string): string[] {
  const code = codeRanges(text);
  const withoutLinks = text.replace(LINK_PATTERN, (m) => " ".repeat(m.length));
  const tags = new Set<string>();
  for (const m of withoutLinks.matchAll(TAG_PATTERN)) {
    const at = m.index + m[1]!.length;
    const tag = m[2]!.replace(/\/+$/, "");
    if (!inside(code, at) && tag && !/^[\d/_-]+$/.test(tag)) tags.add(tag.toLowerCase());
  }
  return [...tags].sort();
}

/** Headings, for the outline. */
export function headings(text: string): { level: number; text: string; from: number }[] {
  const code = codeRanges(text);
  const result: { level: number; text: string; from: number }[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && !inside(code, offset)) result.push({ level: m[1]!.length, text: m[2]!, from: offset });
    offset += line.length + 1;
  }
  return result;
}

/**
 * Rewrites links to a renamed or moved doc. `matches` says whether a link's target (lowercase) referred to the old doc;
 * `replacement` gives the new target text. Headings and aliases are kept. Returns the edits, last first, so they can be
 * applied in order without shifting each other.
 */
export function relinkEdits(text: string, matches: (key: string) => boolean, replacement: (link: WikiLink) => string): { from: number; to: number; insert: string }[] {
  const edits: { from: number; to: number; insert: string }[] = [];
  for (const link of extractLinks(text)) {
    if (!link.target || !matches(link.target.toLowerCase())) continue;
    const inner = replacement(link) + (link.heading ? `#${link.heading}` : "") + (link.alias ? `|${link.alias}` : "");
    edits.push({ from: link.from, to: link.to, insert: `${link.embed ? "!" : ""}[[${inner}]]` });
  }
  return edits.reverse();
}

/** The address of a page comment in the viewer, which is also what "Copy link" in the extension copies. */
export const commentUrlPattern = () => new RegExp(`^${escapeRegExp(location.origin)}/comments/([0-9a-f-]{36})/?$`, "i");

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

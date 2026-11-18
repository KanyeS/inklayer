import MarkdownIt, { type StateInline } from "markdown-it";
import { parseLink, type WikiLink } from "./docMarkdown";

/**
 * Renders a doc for reading, with markdown-it. Safe for text anyone in the organisation wrote:
 * <ul>
 * <li>raw HTML in the markdown is shown as text, never as HTML (<code>html: false</code>);</li>
 * <li>links and images only keep http(s), mailto and same-site addresses (images may also be data: images);</li>
 * <li>[[links]], #tags and [[comment:…]] become links and placeholders that the page wires up.</li>
 * </ul>
 */
export interface LinkResolver {
  /** The doc a link points to, or null if it doesn't exist yet. */
  doc(link: WikiLink): { href: string } | null;
  /** The name (and real name) of a mentioned person. */
  person?(id: string): { displayName: string; fullName: string } | undefined;
}

let currentResolver: LinkResolver | null = null;

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

md.validateLink = (url: string) => safeUrl(url, /^data:image\//i.test(url.trim())) !== null;

// [[Doc]], [[Folder/Doc#Heading|text]], ![[embed]] and [[comment:id]]. Runs before markdown's own links.
md.inline.ruler.before("link", "wikilink", (state: StateInline, silent: boolean) => {
  const src = state.src.slice(state.pos);
  const m = /^(!)?\[\[([^[\]\n]+?)\]\]/.exec(src);
  const link = m ? parseLink(m[2]!, Boolean(m[1]), 0, m[0].length) : null;
  if (!m || !link) return false;
  if (!silent) state.push("wikilink", "", 0).meta = { link };
  state.pos += m[0].length;
  return true;
});

// <@id>: an @mention, shown as the person's name. Before autolinks, which would otherwise see "<…>".
md.inline.ruler.before("autolink", "mention", (state: StateInline, silent: boolean) => {
  const m = /^<@([0-9a-fA-F-]{36})>/.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) state.push("mention", "", 0).meta = { id: m[1]!.toLowerCase() };
  state.pos += m[0].length;
  return true;
});

md.renderer.rules.mention = (tokens, idx) => {
  const { id } = tokens[idx]!.meta as { id: string };
  const person = currentResolver?.person?.(id);
  return `<span class="doc-mention" title="${escapeHtml(person?.fullName ?? "")}">@${escapeHtml(person?.displayName ?? "someone")}</span>`;
};

// #tag at the start of the text or after a space; not all digits (headings are block-level, so never reach here).
md.inline.ruler.push("doctag", (state: StateInline, silent: boolean) => {
  if (state.src[state.pos] !== "#") return false;
  const before = state.pos > 0 ? state.src[state.pos - 1]! : " ";
  if (!/\s/.test(before)) return false;
  const m = /^#([\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/u.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) state.push("doctag", "", 0).meta = { tag: m[1]!.toLowerCase(), raw: m[0] };
  state.pos += m[0].length;
  return true;
});

// Links that leave the site open in a new tab.
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const href = String(tokens[idx]!.attrGet("href") ?? "");
  if (/^https?:/i.test(href) && !href.startsWith(location.origin)) {
    tokens[idx]!.attrSet("target", "_blank");
    tokens[idx]!.attrSet("rel", "noopener noreferrer");
  }
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]!;
  const src = safeUrl(String(token.attrGet("src") ?? ""), true);
  const alt = token.children ? md.renderer.renderInlineAsText(token.children, md.options, {}) : token.content;
  return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer">` : escapeHtml(alt);
};

md.renderer.rules.doctag = (tokens, idx) => {
  const { tag, raw } = tokens[idx]!.meta as { tag: string; raw: string };
  return `<a class="doc-tag" href="#" data-tag="${escapeHtml(tag)}">${escapeHtml(raw)}</a>`;
};

export function renderMarkdown(text: string, resolver: LinkResolver): string {
  currentResolver = resolver;
  md.renderer.rules.wikilink = (tokens, idx) => {
    const { link } = tokens[idx]!.meta as { link: WikiLink };
    if (link.commentId) {
      return `<span class="doc-comment-embed" data-comment-id="${escapeHtml(link.commentId)}">${escapeHtml(link.alias ?? "Comment")}</span>`;
    }
    const shown = link.alias ?? (link.heading ? `${link.target} › ${link.heading}` : link.target!);
    const target = resolver.doc(link);
    return target
      ? `<a class="doc-wikilink" href="${escapeHtml(target.href)}">${escapeHtml(shown)}</a>`
      : `<a class="doc-wikilink unresolved" href="#" data-create="${escapeHtml(link.target!)}" title="Create this doc">${escapeHtml(shown)}</a>`;
  };
  return md.render(text);
}

function safeUrl(url: string, image: boolean): string | null {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed) && !(image && /^mailto:/i.test(trimmed))) return trimmed;
  if (image && /^data:image\/(png|gif|jpe?g|webp);/i.test(trimmed)) return trimmed;
  if (/^(\/(?!\/)|#)/.test(trimmed)) return trimmed;
  return null;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

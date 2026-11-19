/// <reference path="./markdown-it-mark.d.ts" />
import MarkdownIt, { type StateBlock, type StateCore, type StateInline } from "markdown-it";
import { full as emoji } from "markdown-it-emoji";
import footnote from "markdown-it-footnote";
import mark from "markdown-it-mark";
import { parseLink, type WikiLink } from "./docMarkdown";

/**
 * Renders a doc for reading, with markdown-it. Safe for text anyone in the organisation wrote:
 * <ul>
 * <li>raw HTML in the markdown is shown as text, never as HTML (<code>html: false</code>);</li>
 * <li>links and images only keep http(s), mailto and same-site addresses (images may also be data: images);</li>
 * <li>[[links]], #tags and [[comment:…]] become links and placeholders that the page wires up.</li>
 * <li>Also: - [ ] checkboxes, ==highlights==, footnotes, :emoji:, &gt; [!note] callouts, $maths$ and mermaid diagrams.
 * Maths, diagrams and code highlighting are placeholders here; enhance.ts fills them in, loading what they need.</li>
 * </ul>
 */
export interface LinkResolver {
  /** The doc a link points to, or null if it doesn't exist yet. */
  doc(link: WikiLink): { href: string } | null;
  /** The name (and real name) of a mentioned person. */
  person?(id: string): { displayName: string; fullName: string } | undefined;
  /** For guests on a share link: links to docs they can't open, comment embeds and #tags are shown as plain text. */
  guest?: boolean;
  /** Checkboxes can be ticked (by someone who can edit the doc); otherwise they're shown but disabled. */
  tickable?: boolean;
}

let currentResolver: LinkResolver | null = null;

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

md.validateLink = (url: string) => safeUrl(url, /^data:image\//i.test(url.trim())) !== null;

md.use(footnote).use(mark).use(emoji);

/* ------------------------------------------------------------------ checkboxes: "- [ ] task", "- [x] done" */

md.core.ruler.after("inline", "task_lists", (state: StateCore) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i]!;
    const item = tokens[i - 2]!;
    if (inline.type !== "inline" || tokens[i - 1]!.type !== "paragraph_open" || item.type !== "list_item_open")
      continue;
    const first = inline.children?.[0];
    const m = first?.type === "text" ? /^\[([ xX])\](?:\s+|$)/.exec(first.content) : null;
    if (!first || !m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("task_checkbox", "input", 0);
    // The source line, so the reading view can tick it in the doc's text.
    box.meta = { checked: m[1] !== " ", line: item.map?.[0] ?? -1 };
    inline.children!.unshift(box);
    item.attrJoin("class", "task-item");
  }
});

md.renderer.rules.task_checkbox = (tokens, idx) => {
  const { checked, line } = tokens[idx]!.meta as { checked: boolean; line: number };
  const disabled = currentResolver?.tickable ? "" : " disabled";
  return `<input type="checkbox" class="task-checkbox" data-line="${line}"${checked ? " checked" : ""}${disabled} aria-label="${checked ? "Done" : "To do"}"> `;
};

/* ------------------------------------------------------------------ callouts: "> [!warning] Title" */

const CALLOUTS = new Set([
  "note",
  "info",
  "tip",
  "hint",
  "success",
  "check",
  "done",
  "question",
  "help",
  "faq",
  "warning",
  "caution",
  "attention",
  "danger",
  "error",
  "failure",
  "fail",
  "bug",
  "example",
  "quote",
  "cite",
  "abstract",
  "summary",
  "tldr",
  "todo",
  "important",
]);

md.core.ruler.after("task_lists", "callouts", (state: StateCore) => {
  const tokens = state.tokens;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const open = tokens[i]!;
    const inline = tokens[i + 2]!;
    if (open.type !== "blockquote_open" || tokens[i + 1]!.type !== "paragraph_open" || inline.type !== "inline")
      continue;
    const m = /^\[!([a-z]+)\][+-]?[ \t]*([^\n]*)/i.exec(inline.content);
    const kind = m?.[1]?.toLowerCase();
    if (!m || !kind || !CALLOUTS.has(kind)) continue;
    open.attrJoin("class", `callout callout-${kind}`);
    const title = new state.Token("callout_title", "div", 0);
    title.meta = { kind, title: m[2]!.trim() || kind[0]!.toUpperCase() + kind.slice(1) };
    tokens.splice(i + 1, 0, title);
    // Drop the "[!kind] Title" line from the paragraph; hide the paragraph if that was all of it.
    const children = inline.children ?? [];
    const lineEnd = children.findIndex((c) => c.type === "softbreak" || c.type === "hardbreak");
    inline.children = lineEnd < 0 ? [] : children.slice(lineEnd + 1);
    if (inline.children.length === 0) {
      tokens[i + 2]!.hidden = true;
      inline.hidden = true;
      const close = tokens[i + 4];
      if (close?.type === "paragraph_close") close.hidden = true;
    }
  }
});

md.renderer.rules.callout_title = (tokens, idx) => {
  const { kind, title } = tokens[idx]!.meta as { kind: string; title: string };
  return `<div class="callout-title" data-kind="${escapeHtml(kind)}">${md.renderInline(title)}</div>`;
};

/* ------------------------------------------------------------------ maths: $inline$ and $$ blocks */

// $x^2$: not "$ " or " $", and not "$5 and $10" (the closing $ can't be followed by a digit).
md.inline.ruler.after("escape", "math_inline", (state: StateInline, silent: boolean) => {
  if (state.src[state.pos] !== "$" || state.src[state.pos + 1] === "$") return false;
  const m = /^\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?!\d)/.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) state.push("math_inline", "", 0).content = m[1]!;
  state.pos += m[0].length;
  return true;
});

md.block.ruler.before(
  "fence",
  "math_block",
  (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
    const start = state.bMarks[startLine]! + state.tShift[startLine]!;
    const first = state.src.slice(start, state.eMarks[startLine]);
    if (!first.startsWith("$$")) return false;
    // $$ x $$ on one line, or $$ … $$ over several.
    const oneLine = /^\$\$(.+)\$\$\s*$/.exec(first);
    let last = startLine;
    let body = oneLine?.[1] ?? first.slice(2);
    if (!oneLine) {
      const lines: string[] = body.trim() ? [body] : [];
      for (last = startLine + 1; last < endLine; last++) {
        const line = state.src.slice(state.bMarks[last]! + state.tShift[last]!, state.eMarks[last]);
        if (line.trimEnd().endsWith("$$")) {
          lines.push(line.trimEnd().slice(0, -2));
          break;
        }
        lines.push(line);
      }
      if (last >= endLine) return false;
      body = lines.join("\n");
    }
    if (silent) return true;
    const token = state.push("math_block", "div", 0);
    token.content = body.trim();
    token.map = [startLine, last + 1];
    state.line = last + 1;
    return true;
  },
);

md.renderer.rules.math_inline = (tokens, idx) =>
  `<span class="math math-inline" data-tex="${escapeHtml(tokens[idx]!.content)}">${escapeHtml(tokens[idx]!.content)}</span>`;
md.renderer.rules.math_block = (tokens, idx) =>
  `<div class="math math-block" data-tex="${escapeHtml(tokens[idx]!.content)}">${escapeHtml(tokens[idx]!.content)}</div>\n`;

/* ------------------------------------------------------------------ code: mermaid diagrams, and languages for highlighting */

const fence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  if (token.info.trim().toLowerCase() === "mermaid") {
    // The diagram's text until it's drawn (and if it can't be).
    return `<div class="mermaid-diagram" data-source="${escapeHtml(token.content)}"><pre><code>${escapeHtml(token.content)}</code></pre></div>\n`;
  }
  return fence(tokens, idx, options, env, self);
};

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
  return src
    ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer">`
    : escapeHtml(alt);
};

md.renderer.rules.doctag = (tokens, idx) => {
  const { tag, raw } = tokens[idx]!.meta as { tag: string; raw: string };
  if (currentResolver?.guest) return escapeHtml(raw);
  return `<a class="doc-tag" href="#" data-tag="${escapeHtml(tag)}">${escapeHtml(raw)}</a>`;
};

export function renderMarkdown(text: string, resolver: LinkResolver): string {
  currentResolver = resolver;
  md.renderer.rules.wikilink = (tokens, idx) => {
    const { link } = tokens[idx]!.meta as { link: WikiLink };
    if (link.commentId) {
      if (resolver.guest) return "";
      return `<span class="doc-comment-embed" data-comment-id="${escapeHtml(link.commentId)}">${escapeHtml(link.alias ?? "Comment")}</span>`;
    }
    const shown = link.alias ?? (link.heading ? `${link.target} › ${link.heading}` : link.target!);
    const target = resolver.doc(link);
    if (!target && resolver.guest) return `<span class="doc-wikilink-text">${escapeHtml(shown)}</span>`;
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

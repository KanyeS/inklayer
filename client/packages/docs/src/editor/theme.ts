import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * How the docs editor looks. CodeMirror scopes these rules to the editor itself (EditorView.theme), so they can't leak
 * into the page or be overridden by it; the colours are the Inklayer theme's CSS variables. Reading view styles are in
 * reading.css.
 */

/** Markdown syntax colours and sizes, close to Obsidian's: headings large, markup characters faded. */
export const obsidianStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.75em", fontWeight: "700", lineHeight: "1.3" },
  { tag: tags.heading2, fontSize: "1.45em", fontWeight: "700", lineHeight: "1.3" },
  { tag: tags.heading3, fontSize: "1.25em", fontWeight: "650" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontSize: "1.1em", fontWeight: "650" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--primary)" },
  { tag: tags.url, color: "var(--muted-foreground)" },
  { tag: tags.quote, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: tags.monospace, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.9em" },
  {
    tag: [tags.processingInstruction, tags.meta],
    color: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)",
  },
  { tag: tags.list, color: "var(--primary)" },
]);

/** The editor's frame, caret, selection, links, tags, chips and suggestion list. */
export const theme = EditorView.theme({
  "&": { fontSize: "16px", color: "var(--foreground)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans, system-ui), sans-serif", lineHeight: "1.7", overflow: "visible" },
  ".cm-content": { padding: "8px 0 40vh", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent) !important",
  },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-wikilink": {
    color: "var(--primary)",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in oklab, var(--primary) 35%, transparent)",
    textUnderlineOffset: "3px",
    cursor: "pointer",
  },
  ".cm-doctag": {
    color: "var(--primary)",
    backgroundColor: "color-mix(in oklab, var(--primary) 10%, transparent)",
    borderRadius: "999px",
    padding: "0 6px",
  },
  ".cm-comment-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    maxWidth: "28em",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    verticalAlign: "bottom",
    padding: "0 8px",
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: "0.9em",
    backgroundColor: "color-mix(in oklab, var(--primary) 10%, transparent)",
    border: "1px solid color-mix(in oklab, var(--primary) 25%, transparent)",
  },
  ".cm-comment-chip-icon": { display: "inline-flex", color: "var(--primary)" },
  ".cm-comment-chip-icon svg": { width: "0.95em", height: "0.95em" },
  ".cm-mention": {
    color: "var(--primary)",
    fontWeight: "600",
    backgroundColor: "color-mix(in oklab, var(--primary) 10%, transparent)",
    borderRadius: "6px",
    padding: "0 3px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    border: "1px solid var(--border)",
    borderRadius: "12px",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-completionDetail": { marginLeft: "8px", color: "var(--muted-foreground)", fontStyle: "normal" },
  ".cm-ySelectionInfo": {
    fontFamily: "system-ui, sans-serif",
    fontWeight: "600",
    fontSize: "11px",
    padding: "1px 6px",
    borderRadius: "3px 6px 6px 6px",
    opacity: "1",
    top: "1.3em",
    left: "-1px",
  },
});

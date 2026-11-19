import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType, drawSelection, dropCursor, keymap, placeholder,
  type DecorationSet, type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { MessageSquare, createElement as createIcon } from "lucide";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { LINK_PATTERN, commentUrlPattern, parseLink, type WikiLink } from "./docMarkdown";
import { applyFormat } from "./formatting";

export interface EditorHooks {
  /** People in the organisation whose name matches, for @ suggestions. */
  people?(query: string): Promise<{ id: string; displayName: string; fullName: string }[]>;
  /** Name and real name for a mentioned person, once known. */
  person?(id: string): { displayName: string; fullName: string } | undefined;
  /** Docs that [[ suggests. */
  titles(): { title: string; folder: string }[];
  openLink(link: WikiLink, newTab: boolean): void;
  openComment(id: string): void;
  /** A short label for a linked comment, once known. */
  commentLabel(id: string): string | undefined;
  /** Where this person's pointer is in the text, for others to see; null when it leaves. */
  onPointer(pointer: { pos: number; dx: number; dy: number } | null): void;
}

export interface DocEditor {
  view: EditorView;
  setEditable(editable: boolean): void;
  /** Redraws comment chips after their labels load. */
  refreshChips(): void;
  destroy(): void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * What the editor needs from a doc session: the shared text, everyone's carets (awareness), and whether this person may
 * edit. A live DocSession (collab.ts) provides them; so can a local Y.Doc, as on the showcase site.
 */
export interface EditorSession {
  text: Y.Text;
  awareness: Awareness;
  canEdit: boolean;
}

export function createEditor(parent: HTMLElement, session: EditorSession, hooks: EditorHooks): DocEditor {
  const editable = new Compartment();
  const undoManager = new Y.UndoManager(session.text);
  let pointerTimer = 0;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: session.text.toString(),
      extensions: [
        // Formatting shortcuts first, so Ctrl/⌘+I is italic rather than CodeMirror's "select parent syntax".
        keymap.of([
          { key: "Mod-b", run: (v) => applyFormat(v, "bold") },
          { key: "Mod-i", run: (v) => applyFormat(v, "italic") },
          { key: "Mod-e", run: (v) => applyFormat(v, "code") },
          ...yUndoManagerKeymap, ...defaultKeymap, indentWithTab,
        ]),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(obsidianStyle),
        yCollab(session.text, session.awareness, { undoManager }),
        editable.of(editableExtensions(session.canEdit)),
        placeholder(session.canEdit ? "Start writing. [[ links a doc, # adds a tag." : "This doc is empty."),
        // Suggestions start 40 ms after a keystroke rather than CodeMirror's 100. Any edit that isn't the user's own
        // typing, such as a collaborator's arriving, restarts that wait (and cancels a lookup in progress), so a short
        // wait still finishes between the batches of others' edits, which arrive about every 250 ms.
        autocompletion({ override: [linkCompletion(hooks), mentionCompletion(hooks)], icons: false, activateOnTypingDelay: 40 }),
        linkMarks,
        tagMarks,
        commentChips(hooks),
        mentionChips(hooks),
        EditorView.domEventHandlers({
          click(event) {
            const el = (event.target as Element).closest<HTMLElement>(".cm-wikilink");
            if (!el || !(isMac ? event.metaKey : event.ctrlKey)) return false;
            const link = parseLink(el.dataset.link ?? "", false, 0, 0);
            if (!link) return false;
            event.preventDefault();
            if (link.commentId) hooks.openComment(link.commentId);
            else hooks.openLink(link, event.shiftKey);
            return true;
          },
          mousemove(event, view) {
            if (pointerTimer) return false;
            pointerTimer = window.setTimeout(() => {
              pointerTimer = 0;
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
              const coords = view.coordsAtPos(pos);
              if (coords) hooks.onPointer({ pos, dx: Math.round(event.clientX - coords.left), dy: Math.round(event.clientY - coords.top) });
            }, 50);
            return false;
          },
          mouseleave() {
            hooks.onPointer(null);
            return false;
          },
          // A pasted link to a page comment becomes [[comment:…]].
          paste(event, view) {
            const text = event.clipboardData?.getData("text/plain").trim() ?? "";
            const id = commentUrlPattern().exec(text)?.[1];
            if (!id) return false;
            event.preventDefault();
            view.dispatch(view.state.replaceSelection(`[[comment:${id.toLowerCase()}]]`));
            return true;
          },
        }),
        theme,
      ],
    }),
  });

  return {
    view,
    setEditable: (value) => view.dispatch({ effects: editable.reconfigure(editableExtensions(value)) }),
    refreshChips: () => view.dispatch({ effects: [] }),
    destroy: () => {
      clearTimeout(pointerTimer);
      undoManager.destroy();
      view.destroy();
    },
  };
}

function editableExtensions(value: boolean) {
  return [EditorView.editable.of(value), EditorState.readOnly.of(!value)];
}

/* ------------------------------------------------------------------ links, tags, comment chips */

const linkMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  readonly #matcher = new MatchDecorator({
    regexp: new RegExp(LINK_PATTERN.source, "g"),
    decoration: (m) => {
      const isComment = /^\s*comment:/i.test(m[2]!);
      return Decoration.mark({
        class: isComment ? "cm-wikilink cm-commentlink" : "cm-wikilink",
        attributes: { "data-link": m[2]!, title: `${isMac ? "⌘" : "Ctrl"}+click to open` },
      });
    },
  });

  constructor(view: EditorView) {
    this.decorations = this.#matcher.createDeco(view);
  }

  update(update: ViewUpdate) {
    this.decorations = this.#matcher.updateDeco(update, this.decorations);
  }
}, { decorations: (v) => v.decorations });

const tagMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  readonly #matcher = new MatchDecorator({
    regexp: /(^|\s)(#[\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/gu,
    decorate: (add, from, _to, m) => {
      const start = from + m[1]!.length;
      add(start, start + m[2]!.length, Decoration.mark({ class: "cm-doctag" }));
    },
  });

  constructor(view: EditorView) {
    this.decorations = this.#matcher.createDeco(view);
  }

  update(update: ViewUpdate) {
    this.decorations = this.#matcher.updateDeco(update, this.decorations);
  }
}, { decorations: (v) => v.decorations });

class CommentChip extends WidgetType {
  constructor(readonly id: string, readonly label: string, readonly open: (id: string) => void) {
    super();
  }

  override eq(other: CommentChip) {
    return other.id === this.id && other.label === this.label;
  }

  toDOM() {
    const chip = document.createElement("span");
    chip.className = "cm-comment-chip";
    chip.title = "Page comment: click to open";
    const icon = document.createElement("span");
    icon.className = "cm-comment-chip-icon";
    icon.append(createIcon(MessageSquare));
    const text = document.createElement("span");
    text.textContent = this.label;
    chip.append(icon, text);
    chip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.open(this.id);
    });
    return chip;
  }

  override ignoreEvent() {
    return true;
  }
}

/** [[comment:id]] shows as a chip with the comment's text, except while the cursor is in it, so it can still be edited. */
function commentChips(hooks: EditorHooks) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.#build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.length > 0) {
        this.decorations = this.#build(update.view);
      }
    }

    #build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const { from: selFrom, to: selTo } = view.state.selection.main;
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to);
        for (const m of text.matchAll(new RegExp(LINK_PATTERN.source, "g"))) {
          const start = from + m.index;
          const end = start + m[0].length;
          const link = parseLink(m[2]!, Boolean(m[1]), start, end);
          if (!link?.commentId || (selFrom <= end && selTo >= start)) continue;
          const label = link.alias ?? hooks.commentLabel(link.commentId) ?? "Comment";
          builder.add(start, end, Decoration.replace({ widget: new CommentChip(link.commentId, label, hooks.openComment) }));
        }
      }
      return builder.finish();
    }
  }, { decorations: (v) => v.decorations });
}

class MentionChip extends WidgetType {
  constructor(readonly name: string, readonly fullName: string) {
    super();
  }

  override eq(other: MentionChip) {
    return other.name === this.name && other.fullName === this.fullName;
  }

  toDOM() {
    const chip = document.createElement("span");
    chip.className = "cm-mention";
    chip.textContent = `@${this.name}`;
    chip.title = this.fullName;
    return chip;
  }
}

/** <@id> shows as @Name (real name on hover), except while the cursor is in it. */
function mentionChips(hooks: EditorHooks) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.#build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.length > 0) this.decorations = this.#build(update.view);
    }

    #build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const { from: selFrom, to: selTo } = view.state.selection.main;
      for (const { from, to } of view.visibleRanges) {
        for (const m of view.state.sliceDoc(from, to).matchAll(/<@([0-9a-f-]{36})>/gi)) {
          const start = from + m.index;
          const end = start + m[0].length;
          if (selFrom <= end && selTo >= start) continue;
          const person = hooks.person?.(m[1]!.toLowerCase());
          builder.add(start, end, Decoration.replace({ widget: new MentionChip(person?.displayName ?? "someone", person?.fullName ?? "") }));
        }
      }
      return builder.finish();
    }
  }, { decorations: (v) => v.decorations });
}

/** Typing @ suggests people in the organisation; picking one inserts <@id>, shown as their name. */
function mentionCompletion(hooks: EditorHooks) {
  // Lookups are kept for a while: when a collaborator's edit cancels a lookup halfway, CodeMirror asks again, and the
  // second ask then gets the answer already on its way instead of starting over (and being cancelled again).
  const lookups = new Map<string, { at: number; people: ReturnType<NonNullable<EditorHooks["people"]>> }>();
  const lookUp = (query: string) => {
    const key = query.toLowerCase();
    const cached = lookups.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.people;
    const people = hooks.people!(query);
    lookups.set(key, { at: Date.now(), people });
    people.catch(() => lookups.delete(key));
    return people;
  };
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = context.matchBefore(/(?:^|\s)@[^\s@<>[\]]{0,30}$/);
    if (!before || !hooks.people) return null;
    const at = before.from + before.text.indexOf("@");
    const people = await lookUp(before.text.slice(before.text.indexOf("@") + 1));
    return {
      from: at,
      filter: false,
      options: people.map((p) => ({
        label: `@${p.displayName}`,
        detail: p.fullName !== p.displayName ? p.fullName : undefined,
        apply: `<@${p.id}> `,
      })),
    };
  };
}

/* ------------------------------------------------------------------ [[ suggestions */

function linkCompletion(hooks: EditorHooks) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[[^[\]\n|#]*$/);
    if (!before) return null;
    const typed = before.text.slice(2);
    const docs = hooks.titles();
    const counts = new Map<string, number>();
    for (const d of docs) counts.set(d.title.toLowerCase(), (counts.get(d.title.toLowerCase()) ?? 0) + 1);
    const options: Completion[] = docs.map((d) => {
      // Same title in two folders: link by path.
      const target = (counts.get(d.title.toLowerCase()) ?? 0) > 1 && d.folder ? `${d.folder}/${d.title}` : d.title;
      return {
        label: target,
        detail: d.folder || undefined,
        apply: (view, _completion, from, to) => {
          const closed = view.state.sliceDoc(to, to + 2) === "]]";
          view.dispatch({ changes: { from, to, insert: closed ? target : `${target}]]` }, selection: { anchor: from + target.length + 2 } });
        },
      };
    });
    if (typed.trim() && !docs.some((d) => d.title.toLowerCase() === typed.trim().toLowerCase())) {
      options.push({ label: typed.trim(), detail: "new doc", boost: -99 });
    }
    return { from: before.from + 2, options, validFor: /^[^[\]\n|#]*$/ };
  };
}

/* ------------------------------------------------------------------ look */

const obsidianStyle = HighlightStyle.define([
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
  { tag: [tags.processingInstruction, tags.meta], color: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)" },
  { tag: tags.list, color: "var(--primary)" },
]);

const theme = EditorView.theme({
  "&": { fontSize: "16px", color: "var(--foreground)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans, system-ui), sans-serif", lineHeight: "1.7", overflow: "visible" },
  ".cm-content": { padding: "8px 0 40vh", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent) !important" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-wikilink": { color: "var(--primary)", textDecoration: "underline", textDecorationColor: "color-mix(in oklab, var(--primary) 35%, transparent)", textUnderlineOffset: "3px", cursor: "pointer" },
  ".cm-doctag": { color: "var(--primary)", backgroundColor: "color-mix(in oklab, var(--primary) 10%, transparent)", borderRadius: "999px", padding: "0 6px" },
  ".cm-comment-chip": {
    display: "inline-flex", alignItems: "center", gap: "4px", maxWidth: "28em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    verticalAlign: "bottom", padding: "0 8px", borderRadius: "8px", cursor: "pointer", fontSize: "0.9em",
    backgroundColor: "color-mix(in oklab, var(--primary) 10%, transparent)", border: "1px solid color-mix(in oklab, var(--primary) 25%, transparent)",
  },
  ".cm-comment-chip-icon": { display: "inline-flex", color: "var(--primary)" },
  ".cm-comment-chip-icon svg": { width: "0.95em", height: "0.95em" },
  ".cm-mention": { color: "var(--primary)", fontWeight: "600", backgroundColor: "color-mix(in oklab, var(--primary) 10%, transparent)", borderRadius: "6px", padding: "0 3px" },
  ".cm-tooltip.cm-tooltip-autocomplete": { border: "1px solid var(--border)", borderRadius: "12px", backgroundColor: "var(--popover)", color: "var(--popover-foreground)", overflow: "hidden" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-foreground)" },
  ".cm-completionDetail": { marginLeft: "8px", color: "var(--muted-foreground)", fontStyle: "normal" },
  ".cm-ySelectionInfo": { fontFamily: "system-ui, sans-serif", fontWeight: "600", fontSize: "11px", padding: "1px 6px", borderRadius: "3px 6px 6px 6px", opacity: "1", top: "1.3em", left: "-1px" },
});

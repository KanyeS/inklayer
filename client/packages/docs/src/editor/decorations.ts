import type { Extension } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { createElement as createIcon, MessageSquare } from "lucide";
import { LINK_PATTERN, parseLink } from "../docMarkdown";
import type { EditorHooks } from "./hooks";

/**
 * How links, tags, linked comments and @mentions look in the editor: [[links]] and #tags are marked; [[comment:id]]
 * and <@id> are replaced by chips while the cursor isn't in them.
 */

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The key that opens a link with a click: ⌘ on a Mac, Ctrl elsewhere. */
export function openModifier(event: MouseEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

/** A plugin that marks whatever `matcher` finds, kept up to date as the text changes. */
function matchPlugin(matcher: MatchDecorator): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view);
      }

      update(update: ViewUpdate) {
        this.decorations = matcher.updateDeco(update, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** [[links]] as underlined links (⌘/Ctrl+click opens them); [[comment:…]] links get a class of their own. */
export const linkMarks = matchPlugin(
  new MatchDecorator({
    regexp: new RegExp(LINK_PATTERN.source, "g"),
    decoration: (m) => {
      const inner = m[2] ?? "";
      const isComment = /^\s*comment:/i.test(inner);
      return Decoration.mark({
        class: isComment ? "cm-wikilink cm-commentlink" : "cm-wikilink",
        attributes: { "data-link": inner, title: `${isMac ? "⌘" : "Ctrl"}+click to open` },
      });
    },
  }),
);

/** #tags as pills. A tag starts after a space or a line start and has at least one letter or underscore. */
export const TAG_PATTERN = /(^|\s)(#[\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/gu;

export const tagMarks = matchPlugin(
  new MatchDecorator({
    regexp: TAG_PATTERN,
    decorate: (add, from, _to, m) => {
      const start = from + (m[1] ?? "").length;
      add(start, start + (m[2] ?? "").length, Decoration.mark({ class: "cm-doctag" }));
    },
  }),
);

/** A piece of text shown as a widget: where it is, and the widget to show. */
interface Chip {
  from: number;
  to: number;
  widget: WidgetType;
}

/**
 * A plugin that replaces what `find` finds in the visible text with widgets, except where the selection touches it,
 * so the text underneath can still be edited.
 */
function chipPlugin(find: (text: string, offset: number) => Chip[]): Extension {
  const build = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    const { from: selFrom, to: selTo } = view.state.selection.main;
    for (const { from, to } of view.visibleRanges) {
      for (const chip of find(view.state.sliceDoc(from, to), from)) {
        if (selFrom <= chip.to && selTo >= chip.from) continue;
        builder.add(chip.from, chip.to, Decoration.replace({ widget: chip.widget }));
      }
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view);
      }

      update(update: ViewUpdate) {
        // Any transaction may carry new labels (refreshChips), so rebuild on all of them.
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.length > 0) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

class CommentChip extends WidgetType {
  constructor(
    readonly id: string,
    readonly label: string,
    readonly open: (id: string) => void,
  ) {
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

/** [[comment:id]] shows as a chip with the comment's text (or its alias). */
export function commentChips(hooks: EditorHooks): Extension {
  return chipPlugin((text, offset) => {
    const chips: Chip[] = [];
    for (const m of text.matchAll(new RegExp(LINK_PATTERN.source, "g"))) {
      const from = offset + m.index;
      const to = from + m[0].length;
      const link = parseLink(m[2] ?? "", Boolean(m[1]), from, to);
      if (!link?.commentId) continue;
      const label = link.alias ?? hooks.commentLabel(link.commentId) ?? "Comment";
      chips.push({ from, to, widget: new CommentChip(link.commentId, label, hooks.openComment) });
    }
    return chips;
  });
}

class MentionChip extends WidgetType {
  constructor(
    readonly name: string,
    readonly fullName: string,
  ) {
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

const MENTION = /<@([0-9a-f-]{36})>/gi;

/** <@id> shows as @Name, with their real name on hover. */
export function mentionChips(hooks: EditorHooks): Extension {
  return chipPlugin((text, offset) =>
    [...text.matchAll(MENTION)].map((m) => {
      const person = hooks.person?.((m[1] ?? "").toLowerCase());
      const from = offset + m.index;
      return {
        from,
        to: from + m[0].length,
        widget: new MentionChip(person?.displayName ?? "someone", person?.fullName ?? ""),
      };
    }),
  );
}

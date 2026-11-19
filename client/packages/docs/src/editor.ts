import { autocompletion } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap, placeholder } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { commentUrlPattern, parseLink } from "./docMarkdown";
import { linkCompletion, mentionCompletion } from "./editor/completions";
import { commentChips, linkMarks, mentionChips, openModifier, tagMarks } from "./editor/decorations";
import type { DocEditor, EditorHooks, EditorSession } from "./editor/hooks";
import { obsidianStyle, theme } from "./editor/theme";
import { applyFormat } from "./formatting";

export type { DocEditor, EditorHooks, EditorSession } from "./editor/hooks";

/**
 * The docs editor: CodeMirror on the doc's shared Yjs text, with Markdown highlighting, everyone's carets, [[link]] and
 * @mention suggestions, and chips for linked comments and people. The pieces are in editor/.
 */

/** Pointer positions are sent to others at most this often. */
const POINTER_EVERY_MS = 50;

export function createEditor(parent: HTMLElement, session: EditorSession, hooks: EditorHooks): DocEditor {
  const editable = new Compartment();
  const undoManager = new Y.UndoManager(session.text);
  const events = editorEvents(hooks);

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
          ...yUndoManagerKeymap,
          ...defaultKeymap,
          indentWithTab,
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
        autocompletion({
          override: [linkCompletion(hooks), mentionCompletion(hooks)],
          icons: false,
          activateOnTypingDelay: 40,
        }),
        linkMarks,
        tagMarks,
        commentChips(hooks),
        mentionChips(hooks),
        events.extension,
        theme,
      ],
    }),
  });

  return {
    view,
    setEditable: (value) => view.dispatch({ effects: editable.reconfigure(editableExtensions(value)) }),
    refreshChips: () => view.dispatch({ effects: [] }),
    destroy: () => {
      events.dispose();
      undoManager.destroy();
      view.destroy();
    },
  };
}

function editableExtensions(value: boolean) {
  return [EditorView.editable.of(value), EditorState.readOnly.of(!value)];
}

/**
 * ⌘/Ctrl+click opens links; pointer moves are shared (throttled) as a text position; a pasted link to a page comment
 * becomes [[comment:…]].
 */
function editorEvents(hooks: EditorHooks) {
  let pointerTimer = 0;
  const extension = EditorView.domEventHandlers({
    click(event) {
      const el = (event.target as Element).closest<HTMLElement>(".cm-wikilink");
      if (!el || !openModifier(event)) return false;
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
        if (!coords) return;
        hooks.onPointer({
          pos,
          dx: Math.round(event.clientX - coords.left),
          dy: Math.round(event.clientY - coords.top),
        });
      }, POINTER_EVERY_MS);
      return false;
    },
    mouseleave() {
      hooks.onPointer(null);
      return false;
    },
    paste(event, view) {
      const text = event.clipboardData?.getData("text/plain").trim() ?? "";
      const id = commentUrlPattern().exec(text)?.[1];
      if (!id) return false;
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(`[[comment:${id.toLowerCase()}]]`));
      return true;
    },
  });
  return { extension, dispose: () => clearTimeout(pointerTimer) };
}

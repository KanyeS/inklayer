/**
 * Quick formatting for the doc editor: what the toolbar, the shortcuts and the cheat sheet's Insert buttons do to the
 * selection. Each action is a pure function of the editor state (easy to test) that returns the change to make:
 * - wrap the selection (bold, italic, code, links…), or unwrap it if it's already wrapped;
 * - prefix every selected line (headings, lists, checkboxes, quotes), or remove the prefix if they all have it;
 * - insert a block (table, code, diagram, divider…), built from the selection where that makes sense.
 */
import { startCompletion } from "@codemirror/autocomplete";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type FormatId =
  | "bold"
  | "italic"
  | "strike"
  | "highlight"
  | "code"
  | "math"
  | "link"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "numbered"
  | "task"
  | "quote"
  | "callout"
  | "codeblock"
  | "mermaid"
  | "table"
  | "divider"
  | "footnote"
  | "doclink"
  | "tag"
  | "mention";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";

/** The formatting toolbar's buttons, in groups (the viewer's FormatToolbar and the showcase site draw them). */
export const FORMAT_GROUPS: { id: FormatId; title: string }[][] = [
  [
    { id: "bold", title: `Bold (${mod}B)` },
    { id: "italic", title: `Italic (${mod}I)` },
    { id: "strike", title: "Strikethrough" },
    { id: "highlight", title: "Highlight" },
    { id: "code", title: `Inline code (${mod}E)` },
    { id: "link", title: "Link" },
  ],
  [
    { id: "h1", title: "Heading 1" },
    { id: "h2", title: "Heading 2" },
    { id: "h3", title: "Heading 3" },
  ],
  [
    { id: "task", title: "Checkbox: every selected line" },
    { id: "bullet", title: "Bulleted list" },
    { id: "numbered", title: "Numbered list" },
    { id: "quote", title: "Quote" },
    { id: "callout", title: "Callout" },
  ],
  [
    { id: "table", title: "Table (select lines split by commas or tabs to make one from them)" },
    { id: "codeblock", title: "Code block" },
    { id: "mermaid", title: "Diagram (mermaid)" },
    { id: "math", title: "Maths" },
    { id: "footnote", title: "Footnote" },
    { id: "divider", title: "Divider" },
  ],
  [
    { id: "doclink", title: "Link to a doc ([[ ]])" },
    { id: "tag", title: "Tag" },
    { id: "mention", title: "Mention someone" },
  ],
];

/** The change an action makes to the editor's state (null when there's nothing to do). */
export function formatSpec(state: EditorState, id: FormatId): TransactionSpec | null {
  switch (id) {
    case "bold":
      return wrap(state, "**", "**", "bold text");
    case "italic":
      return wrap(state, "*", "*", "italic text");
    case "strike":
      return wrap(state, "~~", "~~", "struck text");
    case "highlight":
      return wrap(state, "==", "==", "highlighted text");
    case "code":
      return wrap(state, "`", "`", "code");
    case "math":
      return wrap(state, "$", "$", "x^2");
    case "doclink":
      return wrap(state, "[[", "]]", "");
    case "link":
      return link(state);
    case "h1":
      return linePrefix(state, "h1");
    case "h2":
      return linePrefix(state, "h2");
    case "h3":
      return linePrefix(state, "h3");
    case "bullet":
      return linePrefix(state, "bullet");
    case "numbered":
      return linePrefix(state, "numbered");
    case "task":
      return linePrefix(state, "task");
    case "quote":
      return linePrefix(state, "quote");
    case "callout":
      return callout(state);
    case "codeblock":
      return fenced(state, "", "");
    case "mermaid":
      return fenced(state, "mermaid", MERMAID_EXAMPLE);
    case "table":
      return table(state);
    case "divider":
      return block(state, "---");
    case "footnote":
      return footnote(state);
    case "tag":
      return tag(state);
    case "mention":
      return insertAtCursor(state, "@");
  }
}

/** Does the action in the editor, and puts the cursor back in it. [[ and @ also open their suggestions. */
export function applyFormat(view: EditorView, id: FormatId): boolean {
  if (view.state.readOnly) return false;
  const spec = formatSpec(view.state, id);
  if (spec) view.dispatch({ ...spec, scrollIntoView: true, userEvent: "input" });
  view.focus();
  if ((id === "doclink" && view.state.selection.main.empty) || id === "mention") startCompletion(view);
  return true;
}

/* ------------------------------------------------------------------ wrapping */

function wrap(state: EditorState, before: string, after: string, placeholder: string): TransactionSpec {
  return state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const outside =
      state.sliceDoc(range.from - before.length, range.from) === before &&
      state.sliceDoc(range.to, range.to + after.length) === after &&
      // *italic* inside **bold**: the stars belong to bold, not to italic.
      !(before === "*" && state.sliceDoc(range.from - 2, range.from) === "**");
    if (outside) {
      return {
        changes: [
          { from: range.from - before.length, to: range.from },
          { from: range.to, to: range.to + after.length },
        ],
        range: EditorSelection.range(range.from - before.length, range.to - before.length),
      };
    }
    if (
      text.length >= before.length + after.length &&
      text.startsWith(before) &&
      text.endsWith(after) &&
      text !== before
    ) {
      const inner = text.slice(before.length, text.length - after.length);
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      };
    }
    const inner = text || placeholder;
    const start = range.from + before.length;
    return {
      changes: { from: range.from, to: range.to, insert: before + inner + after },
      range: EditorSelection.range(start, start + inner.length),
    };
  });
}

/** [text](https://): the selection becomes the link's text, and the address is selected to type over. */
function link(state: EditorState): TransactionSpec {
  return state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to) || "link text";
    const insert = `[${text}](https://)`;
    const at = range.empty ? range.from + 1 : range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: range.empty ? EditorSelection.range(at, at + text.length) : EditorSelection.range(at, at + 8),
    };
  });
}

/* ------------------------------------------------------------------ line prefixes */

type LineKind = "h1" | "h2" | "h3" | "bullet" | "numbered" | "task" | "quote";

/** A line's indent and its heading or list marker (but not a quote, which is handled on its own). */
const MARKER = /^(\s*)(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;

function kindOf(marker: string | undefined): LineKind | null {
  if (!marker) return null;
  if (marker.startsWith("#")) return (["h1", "h2", "h3"] as const)[marker.trim().length - 1] ?? null;
  if (/^[-*+]\s+\[/.test(marker)) return "task";
  if (/^[-*+]/.test(marker)) return "bullet";
  return "numbered";
}

const PREFIX: Record<Exclude<LineKind, "quote" | "numbered">, string> = {
  h1: "# ",
  h2: "## ",
  h3: "### ",
  bullet: "- ",
  task: "- [ ] ",
};

/** Every line the selections touch (a selection ending at the start of a line doesn't include that line). */
function selectedLines(state: EditorState): number[] {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    if (!range.empty && last > first && state.doc.line(last).from === range.to) last--;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

function linePrefix(state: EditorState, kind: LineKind): TransactionSpec {
  const numbers = selectedLines(state);
  const lines = numbers.map((n) => state.doc.line(n));
  // Blank lines in a selection are left alone, unless the selection is just one blank line.
  const targets = lines.length > 1 ? lines.filter((l) => l.text.trim()) : lines;
  const changes: { from: number; to: number; insert: string }[] = [];

  if (kind === "quote") {
    const all = targets.every((l) => /^\s*>/.test(l.text));
    for (const l of targets) {
      const m = /^(\s*)>\s?/.exec(l.text);
      if (all && m) changes.push({ from: l.from + m[1]!.length, to: l.from + m[0].length, insert: "" });
      else if (!all) changes.push({ from: l.from, to: l.from, insert: "> " });
    }
    return { changes };
  }

  const all = targets.every((l) => kindOf(MARKER.exec(l.text)?.[2]) === kind);
  targets.forEach((l, i) => {
    const m = MARKER.exec(l.text)!;
    const from = l.from + m[1]!.length;
    const to = from + (m[2]?.length ?? 0);
    const insert = all ? "" : kind === "numbered" ? `${i + 1}. ` : PREFIX[kind];
    changes.push({ from, to, insert });
  });
  return { changes };
}

/** > [!note] Title, with the selected lines quoted underneath. */
function callout(state: EditorState): TransactionSpec {
  const range = state.selection.main;
  if (range.empty) return block(state, "> [!note] Title\n> ", { select: [10, 15] });
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  const body = state
    .sliceDoc(first.from, last.to)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return {
    changes: { from: first.from, to: last.to, insert: `> [!note]\n${body}` },
    selection: EditorSelection.range(first.from + 4, first.from + 8),
  };
}

/* ------------------------------------------------------------------ blocks */

/**
 * Puts `text` on lines of its own where the selection is, with a blank line before and after when it's next to other
 * text. `select` picks a part of `text` to select afterwards (offsets within it); otherwise the cursor goes after it.
 */
function block(state: EditorState, text: string, { select }: { select?: [number, number] } = {}): TransactionSpec {
  const range = state.selection.main;
  const before = state.sliceDoc(Math.max(0, range.from - 2), range.from);
  const after = state.sliceDoc(range.to, range.to + 2);
  const lead = range.from === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = range.to === state.doc.length || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const start = range.from + lead.length;
  const selection = select
    ? EditorSelection.range(start + select[0], start + select[1])
    : EditorSelection.cursor(start + text.length);
  return { changes: { from: range.from, to: range.to, insert: lead + text + trail }, selection };
}

/** A fenced block (code or diagram) around the selected lines, or with `example` in it. */
function fenced(state: EditorState, language: string, example: string): TransactionSpec {
  const range = state.selection.main;
  if (range.empty) {
    const body = example || "";
    return block(state, `\`\`\`${language}\n${body}\n\`\`\``, {
      select: [language.length + 4, language.length + 4 + body.length],
    });
  }
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  const inner = state.sliceDoc(first.from, last.to);
  return {
    changes: { from: first.from, to: last.to, insert: `\`\`\`${language}\n${inner}\n\`\`\`` },
    selection: EditorSelection.cursor(first.from + inner.length + language.length + 8),
  };
}

const MERMAID_EXAMPLE =
  "flowchart LR\n  A[Report] --> B{Can reproduce?}\n  B -- Yes --> C[Fix]\n  B -- No --> D[Ask for details]";

/**
 * A table: an empty one to fill in, or one made from the selected lines, each a row with its cells split on tabs (as
 * pasted from a spreadsheet), commas, or |. The first row is the header.
 */
export function tableFrom(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "| Column | Column |\n| --- | --- |\n|  |  |\n|  |  |";
  const separator = lines.some((l) => l.includes("\t"))
    ? /\t/
    : lines.some((l) => l.includes("|"))
      ? /\s*\|\s*/
      : /\s*,\s*/;
  const rows = lines.map((l) =>
    l
      .replace(/^\|\s*|\s*\|$/g, "")
      .split(separator)
      .map((c) => c.trim().replace(/\|/g, "\\|")),
  );
  const width = Math.max(...rows.map((r) => r.length));
  const row = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  return [row(rows[0]!), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(row)].join("\n");
}

function table(state: EditorState): TransactionSpec {
  const range = state.selection.main;
  if (range.empty) return block(state, tableFrom(""), { select: [2, 8] });
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  const text = tableFrom(state.sliceDoc(first.from, last.to));
  return {
    changes: { from: first.from, to: last.to, insert: text },
    selection: EditorSelection.cursor(first.from + text.length),
  };
}

/** [^n] at the cursor, and its note at the end of the doc, where the cursor goes to write it. */
function footnote(state: EditorState): TransactionSpec {
  const doc = state.doc.toString();
  let n = 1;
  while (doc.includes(`[^${n}]`)) n++;
  const at = state.selection.main.to;
  const end = state.doc.length;
  const note = `${doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n"}[^${n}]: `;
  return {
    changes: [
      { from: at, insert: `[^${n}]` },
      { from: end, insert: note },
    ],
    selection: EditorSelection.cursor(end + `[^${n}]`.length + note.length),
  };
}

/** #tag from the selected words ("Bug fix" → #bug-fix), or # to start typing one. */
function tag(state: EditorState): TransactionSpec {
  return state.changeByRange((range) => {
    const words = state.sliceDoc(range.from, range.to).trim().replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase();
    const space = range.from > 0 && !/\s/.test(state.sliceDoc(range.from - 1, range.from)) ? " " : "";
    const insert = `${space}#${words}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
}

function insertAtCursor(state: EditorState, text: string): TransactionSpec {
  return state.changeByRange((range) => {
    const space = range.from > 0 && !/\s/.test(state.sliceDoc(range.from - 1, range.from)) ? " " : "";
    const insert = space + text;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
}

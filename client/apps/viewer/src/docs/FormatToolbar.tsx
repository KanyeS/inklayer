import type { ComponentType } from "react";
import type { EditorView } from "@codemirror/view";
import {
  AtSign, Bold, Code, FileSymlink, Hash, Heading1, Heading2, Heading3, Highlighter, Info, Italic, Link, List, ListOrdered, ListTodo,
  MessageSquareWarning, Minus, Sigma, SquareCode, Strikethrough, Superscript, Table, TextQuote, Workflow,
} from "lucide-react";
import { Button } from "@inklayer/ui/components/button";
import { applyFormat, type FormatId } from "./formatting";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";

/** The toolbar's buttons, in groups. Also used by the cheat sheet to name and pick icons for its Insert buttons. */
export const FORMATS: { id: FormatId; title: string; icon: ComponentType<{ className?: string }> }[][] = [
  [
    { id: "bold", title: `Bold (${mod}B)`, icon: Bold },
    { id: "italic", title: `Italic (${mod}I)`, icon: Italic },
    { id: "strike", title: "Strikethrough", icon: Strikethrough },
    { id: "highlight", title: "Highlight", icon: Highlighter },
    { id: "code", title: `Inline code (${mod}E)`, icon: Code },
    { id: "link", title: "Link", icon: Link },
  ],
  [
    { id: "h1", title: "Heading 1", icon: Heading1 },
    { id: "h2", title: "Heading 2", icon: Heading2 },
    { id: "h3", title: "Heading 3", icon: Heading3 },
  ],
  [
    { id: "task", title: "Checkbox: every selected line", icon: ListTodo },
    { id: "bullet", title: "Bulleted list", icon: List },
    { id: "numbered", title: "Numbered list", icon: ListOrdered },
    { id: "quote", title: "Quote", icon: TextQuote },
    { id: "callout", title: "Callout", icon: MessageSquareWarning },
  ],
  [
    { id: "table", title: "Table (select lines split by commas or tabs to make one from them)", icon: Table },
    { id: "codeblock", title: "Code block", icon: SquareCode },
    { id: "mermaid", title: "Diagram (mermaid)", icon: Workflow },
    { id: "math", title: "Maths", icon: Sigma },
    { id: "footnote", title: "Footnote", icon: Superscript },
    { id: "divider", title: "Divider", icon: Minus },
  ],
  [
    { id: "doclink", title: "Link to a doc ([[ ]])", icon: FileSymlink },
    { id: "tag", title: "Tag", icon: Hash },
    { id: "mention", title: "Mention someone", icon: AtSign },
  ],
];

/**
 * Buttons above the editor that format the selection (or insert at the cursor). They don't take focus, so the
 * selection stays where it was.
 */
export function FormatToolbar({ view, onGuide }: { view: () => EditorView | null | undefined; onGuide: () => void }) {
  return (
    <div role="toolbar" aria-label="Formatting"
      className="sticky top-14 z-10 -mx-2 mb-2 flex flex-wrap items-center gap-0.5 rounded-xl border bg-background/95 px-1.5 py-1 backdrop-blur">
      {FORMATS.map((group, i) => (
        <div key={i} className="flex items-center gap-0.5 border-r pr-1 last:border-r-0 [&:not(:first-child)]:pl-1">
          {group.map(({ id, title, icon: Icon }) => (
            <Button key={id} type="button" variant="ghost" size="icon" className="size-7 [&_svg]:size-4" title={title} aria-label={title}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const v = view();
                if (v) applyFormat(v, id);
              }}>
              <Icon />
            </Button>
          ))}
        </div>
      ))}
      <Button type="button" variant="ghost" size="icon" className="ml-auto size-7 [&_svg]:size-4" title="Markdown cheat sheet" aria-label="Markdown cheat sheet"
        onMouseDown={(e) => e.preventDefault()} onClick={onGuide}>
        <Info />
      </Button>
    </div>
  );
}

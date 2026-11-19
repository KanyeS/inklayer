import type { EditorView } from "@codemirror/view";
import { applyFormat, FORMAT_GROUPS, type FormatId } from "@inklayer/docs/formatting";
import { Button } from "@inklayer/ui/components/button";
import {
  AtSign,
  Bold,
  Code,
  FileSymlink,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Info,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  MessageSquareWarning,
  Minus,
  Sigma,
  SquareCode,
  Strikethrough,
  Superscript,
  Table,
  TextQuote,
  Workflow,
} from "lucide-react";
import type { ComponentType } from "react";

/** Each formatting action's Lucide icon. */
const ICONS: Record<FormatId, ComponentType> = {
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  highlight: Highlighter,
  code: Code,
  link: Link,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  task: ListTodo,
  bullet: List,
  numbered: ListOrdered,
  quote: TextQuote,
  callout: MessageSquareWarning,
  table: Table,
  codeblock: SquareCode,
  mermaid: Workflow,
  math: Sigma,
  footnote: Superscript,
  divider: Minus,
  doclink: FileSymlink,
  tag: Hash,
  mention: AtSign,
};

/**
 * Buttons above the editor that format the selection (or insert at the cursor). They don't take focus, so the
 * selection stays where it was.
 */
export function FormatToolbar({ view, onGuide }: { view: () => EditorView | null | undefined; onGuide: () => void }) {
  return (
    <div role="toolbar" aria-label="Formatting" className="doc-format-toolbar">
      {FORMAT_GROUPS.map((group, i) => (
        <div key={i} className="flex items-center gap-0.5 border-r pr-1 last:border-r-0 [&:not(:first-child)]:pl-1">
          {group.map(({ id, title }) => {
            const Icon = ICONS[id];
            return (
              <Button
                key={id}
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 [&_svg]:size-4"
                title={title}
                aria-label={title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const v = view();
                  if (v) applyFormat(v, id);
                }}
              >
                <Icon />
              </Button>
            );
          })}
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="ml-auto size-7 [&_svg]:size-4"
        title="Markdown cheat sheet"
        aria-label="Markdown cheat sheet"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onGuide}
      >
        <Info />
      </Button>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy, CornerDownLeft } from "lucide-react";
import { Button } from "@inklayer/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@inklayer/ui/components/dialog";
import { enhance } from "./enhance";
import type { FormatId } from "./formatting";
import { renderMarkdown } from "./reading";

interface Example {
  label: string;
  /** What to type. Copied as is, unless `copy` is false (things you don't type, like a mention picked from a list). */
  snippet: string;
  copy?: boolean;
  /** Shown instead of rendering the snippet, where a rendered example wouldn't help. */
  preview?: ReactNode;
  note?: string;
  /** What Insert does to the editor's selection (see formatting.ts). */
  format?: FormatId;
}

/**
 * Everything docs understand. Previews are drawn by the reading view's own renderer (reading.ts), so they show exactly
 * what a doc will look like. Only what renders is listed.
 */
const SECTIONS: { title: string; examples: Example[] }[] = [
  {
    title: "Text",
    examples: [
      { label: "Bold", snippet: "**bold**", format: "bold" },
      { label: "Italic", snippet: "*italic*", format: "italic" },
      { label: "Bold and italic", snippet: "***both***" },
      { label: "Strikethrough", snippet: "~~no longer true~~", format: "strike" },
      { label: "Highlight", snippet: "==the important bit==", format: "highlight" },
      { label: "Inline code", snippet: "`npm run build`", format: "code" },
    ],
  },
  {
    title: "Headings",
    examples: [
      { label: "Heading 1", snippet: "# Release plan", format: "h1" },
      { label: "Heading 2", snippet: "## Before launch", format: "h2" },
      { label: "Heading 3", snippet: "### Checks", format: "h3" },
    ],
  },
  {
    title: "Checkboxes, lists and callouts",
    examples: [
      { label: "Checkboxes", snippet: "- [ ] Retest on Safari\n- [x] Fix the banner", format: "task", note: "Insert puts a checkbox before every selected line. Tick them in the reading view." },
      { label: "Bulleted list", snippet: "- Checkout\n- Cart\n  - Nested: indent two spaces", format: "bullet" },
      { label: "Numbered list", snippet: "1. Reproduce\n2. Fix\n3. Retest", format: "numbered" },
      { label: "Quote", snippet: "> Works on my machine.", format: "quote" },
      { label: "Callout", snippet: "> [!warning] Before release\n> Check Safari and Firefox.", format: "callout",
        note: "Kinds: note, tip, success, question, warning, danger, bug, example, quote, important." },
      { label: "Divider", snippet: "---", format: "divider" },
    ],
  },
  {
    title: "Links, images, tables and code",
    examples: [
      { label: "Link", snippet: "[Inklayer](https://inklayer.online)", format: "link" },
      { label: "Bare address", snippet: "https://inklayer.online", note: "Becomes a link by itself." },
      { label: "Image", snippet: "![Checkout on iPhone SE](https://example.com/checkout.png)", preview: <span className="text-muted-foreground">Shows the image (https addresses only).</span> },
      { label: "Table", snippet: "| Page | Status |\n| --- | --- |\n| Checkout | Fixed |\n| Cart | Open |", format: "table",
        note: "Select lines split by commas or tabs (say, pasted from a spreadsheet) and Insert turns them into a table." },
      { label: "Code block", snippet: "```js\nconst total = items.reduce((sum, i) => sum + i.price, 0);\n```", format: "codeblock", note: "Name the language after ``` for colours." },
    ],
  },
  {
    title: "Diagrams, maths and more",
    examples: [
      { label: "Diagram", snippet: "```mermaid\nflowchart LR\n  A[Report] --> B{Can reproduce?}\n  B -- Yes --> C[Fix]\n  B -- No --> D[Ask]\n```", format: "mermaid",
        note: "Flowcharts, sequence diagrams, Gantt charts and more: mermaid.js.org" },
      { label: "Maths", snippet: "$E = mc^2$", format: "math" },
      { label: "Maths block", snippet: "$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$" },
      { label: "Footnote", snippet: "Tested on Safari.[^1]\n\n[^1]: Version 17, on an iPhone SE.", format: "footnote" },
      { label: "Emoji", snippet: ":rocket: :white_check_mark: :warning:" },
    ],
  },
  {
    title: "Inklayer",
    examples: [
      { label: "Link a doc", snippet: "[[Roadmap]]", format: "doclink", note: "Type [[ for suggestions. A doc that doesn't exist yet can be created from the link." },
      { label: "In a folder", snippet: "[[Planning/Roadmap]]" },
      { label: "To a heading", snippet: "[[Roadmap#Before launch]]" },
      { label: "With your own text", snippet: "[[Roadmap|the plan]]" },
      { label: "Tag", snippet: "#launch", format: "tag", note: "No space after #, or it's a heading." },
      { label: "Mention someone", snippet: "Type @ and pick a person", copy: false, format: "mention", preview: <span className="doc-mention">@Alex</span>, note: "They're notified." },
      { label: "Page comment", snippet: "Paste a link to a page comment", copy: false, preview: <span className="text-muted-foreground">Shows the comment as a card, kept up to date.</span>, note: "Stored as [[comment:…]]." },
    ],
  },
];

const RESOLVER = { doc: () => ({ href: "#" }), person: () => ({ displayName: "Alex", fullName: "Alex Rivera" }) };

/**
 * The markdown cheat sheet: what to type, what it looks like, and buttons to copy each or, while editing, to insert it
 * (applied to whatever was selected in the editor).
 */
export function MarkdownGuide({ open, onOpenChange, onInsert }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Applies a format to the editor's selection; absent when the doc isn't being edited. */
  onInsert?: (format: FormatId) => void;
}) {
  const everything = useMemo(() => SECTIONS.map((s) => [`## ${s.title}`, ...s.examples.filter((e) => e.copy !== false).map((e) => e.snippet)].join("\n\n")).join("\n\n"), []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Markdown cheat sheet</DialogTitle>
          <DialogDescription>
            Docs are written in markdown. {onInsert ? "Insert applies an example to what you selected in the doc; or copy one and paste it." : "Copy any example and paste it into a doc."} In the editor, Ctrl+click (⌘+click on a Mac) a link to open it.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-[65vh] space-y-6 overflow-y-auto px-1">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="mb-2 font-heading text-sm font-semibold text-muted-foreground">{section.title}</h3>
              <div className="divide-y rounded-xl border">
                {section.examples.map((example) => <Row key={example.label} example={example} onInsert={onInsert} />)}
              </div>
            </section>
          ))}
        </div>
        <div className="flex justify-between gap-2">
          <CopyButton text={everything} label="Copy all examples" />
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ example, onInsert }: { example: Example; onInsert?: (format: FormatId) => void }) {
  const rendered = useMemo(() => (example.preview ? null : renderMarkdown(example.snippet, RESOLVER)), [example]);
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (preview.current) void enhance(preview.current);
  }, [rendered]);
  return (
    <div className="grid gap-x-4 gap-y-2 p-3 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
      <div className="text-sm font-medium">{example.label}</div>
      {example.copy === false ? (
        // Not something to type: how to do it instead.
        <p className="m-0 px-2.5 text-sm text-muted-foreground italic">{example.snippet}</p>
      ) : (
        <pre className="m-0 overflow-x-auto rounded-lg bg-muted px-2.5 py-1.5 font-mono text-[13px] whitespace-pre select-all">{example.snippet}</pre>
      )}
      <div className="min-w-0 text-sm">
        {/* The reading view's styles, so the preview looks like a doc. Links in it go nowhere. */}
        {example.preview ? <div className="doc-reading text-sm">{example.preview}</div> : (
          <div ref={preview} className="doc-reading text-sm [&>*]:!mt-0" onClickCapture={(e) => e.preventDefault()} dangerouslySetInnerHTML={{ __html: rendered! }} />
        )}
        {example.note && <p className="mt-1 text-xs text-muted-foreground">{example.note}</p>}
      </div>
      {/* Same width with or without buttons, so the columns line up. */}
      <div className="flex w-[4.5rem] justify-end gap-0.5">
        {onInsert && example.format && (
          <Button variant="ghost" size="icon" className="size-8" title="Insert into the doc" aria-label={`Insert ${example.label}`}
            onClick={() => onInsert(example.format!)}>
            <CornerDownLeft />
          </Button>
        )}
        {example.copy !== false && <CopyButton text={example.snippet} />}
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  if (label) {
    return (
      <Button variant="ghost" onClick={() => void copy()}>
        {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}{copied ? "Copied" : label}
      </Button>
    );
  }
  return (
    <Button variant="ghost" size="icon" className="size-8" title={copied ? "Copied" : "Copy"} aria-label={copied ? "Copied" : `Copy ${text}`} onClick={() => void copy()}>
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

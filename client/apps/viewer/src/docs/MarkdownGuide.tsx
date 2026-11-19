import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, CornerDownLeft } from "lucide-react";
import { Button } from "@inklayer/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@inklayer/ui/components/dialog";
import { enhance } from "./enhance";
import type { FormatId } from "./formatting";
import { MARKDOWN_EXAMPLES, type MarkdownExample } from "./markdownExamples";
import { renderMarkdown } from "./reading";

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
  const everything = useMemo(() => MARKDOWN_EXAMPLES.map((s) => [`## ${s.title}`, ...s.examples.filter((e) => e.copy !== false).map((e) => e.snippet)].join("\n\n")).join("\n\n"), []);
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
          {MARKDOWN_EXAMPLES.map((section) => (
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

function Row({ example, onInsert }: { example: MarkdownExample; onInsert?: (format: FormatId) => void }) {
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
        {example.preview ? <div className="doc-reading text-sm [&_.muted]:text-muted-foreground" dangerouslySetInnerHTML={{ __html: example.preview }} /> : (
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

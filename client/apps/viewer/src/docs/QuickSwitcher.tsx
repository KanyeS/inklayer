import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { FilePlus2, FileText, TextSearch } from "lucide-react";
import { cn } from "@inklayer/ui/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@inklayer/ui/components/dialog";
import { navigate } from "@/lib/router";
import { docPath, docsApi, type DocSearchResult, type DocTree } from "./docsApi";
import { fuzzyScore } from "./fuzzy";
import { createFromLink, pathOf } from "./links";
import { TagPill, tagOf, toTag } from "./tags";

type Item =
  | { kind: "doc"; id: string; title: string; folder: string }
  | { kind: "text"; result: DocSearchResult }
  | { kind: "create"; title: string }
  | { kind: "tag"; tag: string };

/** Ctrl/Cmd+K: jump to a doc by title, find words in any doc, find docs by #tag, or create one. */
export function QuickSwitcher({ orgId, tree, open, onOpenChange, onCreated, onTag }: {
  orgId: string;
  tree: DocTree;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
  /** Shows the docs with a tag (in the sidebar). */
  onTag: (tag: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocSearchResult[]>([]);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
    }
  }, [open]);

  // Full-text results, a moment after typing stops. "#…" searches tags instead.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || q.startsWith("#")) {
      setResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      docsApi.search(orgId, q).then(setResults).catch(() => setResults([]));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [orgId, query]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    if (q.startsWith("#")) return tagItems(tree, toTag(q));
    const byTitle = tree.docs
      .map((d) => ({ d, score: q ? fuzzyScore(q, d.title) ?? (fuzzyScore(q, pathOf(d)) ?? -Infinity) - 5 : 0 }))
      .filter((x) => x.score > -Infinity)
      .sort((a, b) => b.score - a.score || b.d.updatedAt.localeCompare(a.d.updatedAt))
      .slice(0, 8)
      .map(({ d }): Item => ({ kind: "doc", id: d.id, title: d.title, folder: d.folder }));
    const titleIds = new Set(byTitle.map((i) => (i.kind === "doc" ? i.id : "")));
    const inText = results.filter((r) => !titleIds.has(r.id)).slice(0, 8).map((result): Item => ({ kind: "text", result }));
    const exact = tree.docs.some((d) => d.title.toLowerCase() === q.toLowerCase() || pathOf(d).toLowerCase() === q.toLowerCase());
    const create: Item[] = q && !exact && tree.canEdit && !/[[\]|#^\\]/.test(q) ? [{ kind: "create", title: q }] : [];
    return [...byTitle, ...inText, ...create];
  }, [query, results, tree]);

  useEffect(() => setSelected(0), [query]);

  const choose = async (item: Item | undefined) => {
    if (!item) return;
    onOpenChange(false);
    if (item.kind === "doc") navigate(docPath(orgId, item.id));
    else if (item.kind === "text") navigate(docPath(orgId, item.result.id));
    else if (item.kind === "tag") onTag(item.tag);
    else {
      const doc = await createFromLink(orgId, item.title);
      await onCreated();
      navigate(docPath(orgId, doc.id));
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(items.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void choose(items[selected]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent position="top" className="gap-2 p-2">
        <DialogTitle className="sr-only">Find a doc</DialogTitle>
        <input
          autoFocus
          className="h-11 w-full rounded-2xl bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground"
          placeholder="Find a doc, search for words, or type # for tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-switcher-results"
        />
        <ul id="quick-switcher-results" role="listbox" className="max-h-[50vh] overflow-y-auto border-t pt-2">
          {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">{query ? "Nothing found." : "No docs yet."}</li>}
          {items.map((item, i) => (
            <li key={item.kind === "doc" ? item.id : item.kind === "text" ? `t-${item.result.id}` : item.kind === "tag" ? `#${item.tag}` : "create"} role="option" aria-selected={i === selected}>
              <button
                type="button"
                onMouseEnter={() => setSelected(i)}
                onClick={() => void choose(item)}
                className={cn("flex w-full items-start gap-2.5 rounded-xl px-3 py-2 text-left text-sm", i === selected && "bg-accent text-accent-foreground")}
              >
                {item.kind === "doc" && <><FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="truncate">{item.title}</span>{item.folder && <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">{item.folder}</span>}</>}
                {item.kind === "text" && (
                  <>
                    <TextSearch className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{item.result.title}</span>
                      <Snippet text={item.result.snippet} />
                    </span>
                  </>
                )}
                {item.kind === "create" && <><FilePlus2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span>Create “{item.title}”</span></>}
                {item.kind === "tag" && <><TagPill tag={tagOf(tree, item.tag)} /><span className="ml-auto pl-3 text-xs text-muted-foreground">Show all {tagOf(tree, item.tag).count} docs</span></>}
              </button>
            </li>
          ))}
        </ul>
        <p className="px-3 pb-1 text-xs text-muted-foreground">↑↓ to move · Enter to open · Esc to close</p>
      </DialogContent>
    </Dialog>
  );
}

/** "#lau": tags starting with (then containing) "lau", most used first, then the docs that have them. */
function tagItems(tree: DocTree, typed: string): Item[] {
  const all = tree.tags ?? [];
  const tags = [...all.filter((t) => t.tag.startsWith(typed)), ...all.filter((t) => !t.tag.startsWith(typed) && t.tag.includes(typed))].slice(0, 5);
  const names = new Set(tags.map((t) => t.tag));
  const docs = tree.docs
    .filter((d) => d.tags.some((t) => names.has(t)))
    .sort((a, b) => Number(b.tags.includes(typed)) - Number(a.tags.includes(typed)) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8)
    .map((d): Item => ({ kind: "doc", id: d.id, title: d.title, folder: d.folder }));
  return [...tags.map((t): Item => ({ kind: "tag", tag: t.tag })), ...docs];
}

/** The server marks matched words with \u0002 … \u0003. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/);
  return (
    <span className="line-clamp-2 text-xs text-muted-foreground">
      {parts.map((p, i) => (p.startsWith("\u0002") ? <mark key={i} className="rounded bg-primary/20 px-0.5 text-foreground">{p.slice(1, -1)}</mark> : p))}
    </span>
  );
}

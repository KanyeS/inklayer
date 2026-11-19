/**
 * Tags as pills: a doc's #tags at the top of the doc. Tags live in the doc's text (so they're searchable and work wherever
 * tags do); each tag's icon and colour are optional and set once for the whole organisation.
 */
import { useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { Palette, Plus, X } from "lucide-react";
import { cn } from "@inklayer/ui/lib/utils";
import { Button } from "@inklayer/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@inklayer/ui/components/dialog";
import { Input } from "@inklayer/ui/components/input";
import type { DocSession } from "./collab";
import { IconSvg, useIcons } from "./docIcons";
import { addTag, extractTags, removeTag, textEdit } from "./docMarkdown";
import { docsApi, type DocTagInfo, type DocTree } from "./docsApi";
import { IconPicker } from "./IconPicker";

/** A tag that #tag extraction would find: letters, digits, _ / -, with at least one letter or _. */
const VALID_TAG = /^[\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*$/u;

/** "#Launch Plan" → "launch-plan": what someone typed, as a tag. */
export function toTag(text: string): string {
  return text.trim().replace(/^#+/, "").replace(/\s+/g, "-").replace(/\/+$/, "").toLowerCase();
}

export const tagOf = (tree: DocTree, tag: string): DocTagInfo => tree.tags?.find((t) => t.tag === tag) ?? { tag, count: 0 };

/** One tag: its icon (if it has one) and #name, in its colour. */
export function TagPill({ tag: info, active, onClick, onRemove, children, className }: {
  tag: DocTagInfo;
  active?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  children?: ReactNode;
  className?: string;
}) {
  const library = useIcons();
  const icon = library?.get(info.icon);
  const style = info.color
    ? { color: info.color, background: `color-mix(in oklab, ${info.color} ${active ? 26 : 13}%, transparent)`, boxShadow: active ? `inset 0 0 0 1px ${info.color}` : undefined }
    : undefined;
  const Name = onClick ? "button" : "span";
  return (
    <span className={cn("doc-tag-pill inline-flex max-w-full items-center rounded-full text-xs font-medium",
      !info.color && (active ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"), className)} style={style}>
      <Name type={onClick ? "button" : undefined} onClick={onClick} title={onClick ? `Docs tagged #${info.tag}` : undefined}
        className={cn("inline-flex min-w-0 items-center gap-1 py-0.5 pl-2", onRemove ? "pr-1" : "pr-2", onClick && "cursor-pointer hover:opacity-80")}>
        {icon && <IconSvg node={icon} className="size-3.5 shrink-0" />}
        <span className="truncate">#{info.tag}</span>
        {children}
      </Name>
      {onRemove && (
        <button type="button" onClick={onRemove} title={`Remove #${info.tag} from this doc`} aria-label={`Remove #${info.tag}`}
          className="mr-1 rounded-full p-0.5 opacity-60 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

/** The doc's text as it is now, re-rendering as anyone edits it. */
function useLiveText(session: DocSession): string {
  return useSyncExternalStore(
    (listener) => {
      session.text.observe(listener);
      return () => session.text.unobserve(listener);
    },
    () => session.text.toString(),
  );
}

/** Changes the live doc's text the smallest way, so it merges with anyone typing at the same time. */
function editText(session: DocSession, change: (text: string) => string) {
  const before = session.text.toString();
  const edit = textEdit(before, change(before));
  if (!edit) return;
  session.doc.transact(() => {
    if (edit.to > edit.from) session.text.delete(edit.from, edit.to - edit.from);
    if (edit.insert) session.text.insert(edit.from, edit.insert);
  });
}

/** The tags at the top of a doc: click one to list docs with it; editors can add and remove them. */
export function TagBar({ orgId, tree, session, fallback, canEdit, onTag, onTreeChanged }: {
  orgId: string;
  tree: DocTree;
  session: DocSession;
  /** The server's tags, until the doc's text has loaded. */
  fallback: string[];
  canEdit: boolean;
  onTag: (tag: string) => void;
  onTreeChanged: () => Promise<void>;
}) {
  const text = useLiveText(session);
  const tags = session.loaded ? extractTags(text) : fallback;
  const [open, setOpen] = useState(false);
  if (tags.length === 0 && !canEdit) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <TagPill key={tag} tag={tagOf(tree, tag)} onClick={() => onTag(tag)}
          onRemove={canEdit ? () => editText(session, (t) => removeTag(t, tag)) : undefined} />
      ))}
      {canEdit && (
        <Button variant="ghost" size="sm" className="h-6 rounded-full px-2 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
          <Plus data-icon="inline-start" />Tag
        </Button>
      )}
      <TagDialog orgId={orgId} tree={tree} tags={tags} open={open} onOpenChange={setOpen}
        onAdd={(tag) => editText(session, (t) => addTag(t, tag))}
        onRemove={(tag) => editText(session, (t) => removeTag(t, tag))}
        onTreeChanged={onTreeChanged} />
    </div>
  );
}

/** Add tags (with suggestions from tags in use), remove them, and set each one's icon and colour. */
function TagDialog({ orgId, tree, tags, open, onOpenChange, onAdd, onRemove, onTreeChanged }: {
  orgId: string;
  tree: DocTree;
  tags: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
  onTreeChanged: () => Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [styling, setStyling] = useState<DocTagInfo | null>(null);
  const [error, setError] = useState("");
  const typed = toTag(input);
  const suggestions = (tree.tags ?? []).filter((l) => !tags.includes(l.tag) && (!typed || l.tag.includes(typed))).slice(0, 12);

  const add = (tag: string) => {
    if (!VALID_TAG.test(tag)) {
      setError("Tags use letters, numbers, - _ and /, and need at least one letter.");
      return;
    }
    onAdd(tag);
    setInput("");
    setError("");
  };
  const style = async (info: DocTagInfo, next: { icon: string | null; color: string | null }) => {
    setStyling({ ...info, ...next });
    try {
      await docsApi.setTagStyle(orgId, info.tag, next);
      await onTreeChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Tags</DialogTitle>
          <DialogDescription>Tags are added to the doc's text as #tag, so they're searchable. A tag's icon and colour apply to every doc that has it.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input autoFocus placeholder="Add a tag, e.g. launch" aria-label="New tag" value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter" && typed) {
                e.preventDefault();
                add(typed);
              }
            }} />
          <Button disabled={!typed} onClick={() => add(typed)}>Add</Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((l) => (
              <TagPill key={l.tag} tag={l} onClick={() => add(l.tag)}><span className="opacity-60">{l.count}</span></TagPill>
            ))}
          </div>
        )}

        <div className="divide-y rounded-xl border">
          {tags.length === 0 && <p className="p-3 text-sm text-muted-foreground">This doc has no tags yet.</p>}
          {tags.map((tag) => {
            const info = tagOf(tree, tag);
            return (
              <div key={tag} className="flex items-center gap-2 p-2 pl-3">
                <TagPill tag={info} className="mr-auto" />
                <Button variant="ghost" size="sm" onClick={() => setStyling(info)}><Palette data-icon="inline-start" />Icon and colour</Button>
                <Button variant="ghost" size="icon" className="size-8" title={`Remove #${tag}`} aria-label={`Remove #${tag}`} onClick={() => onRemove(tag)}><X /></Button>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end">
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
      {styling && (
        <IconPicker open onOpenChange={(o) => !o && setStyling(null)} defaultIcon={null}
          title={`#${styling.tag}`} description="An icon and colour for this tag, wherever it's used in the organisation. Both are optional."
          value={{ icon: styling.icon ?? null, color: styling.color ?? null }}
          onChange={(next) => void style(styling, next)} />
      )}
    </Dialog>
  );
}

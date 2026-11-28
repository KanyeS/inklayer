import { Input } from "@inklayer/ui/components/input";
import { cn } from "@inklayer/ui/lib/utils";
import { Panel, useReactFlow } from "@xyflow/react";
import {
  Columns3,
  FilePlus2,
  FileText,
  Image,
  Link2,
  MessageSquare,
  Network,
  Redo2,
  StickyNote,
  Undo2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { DocIcon } from "@/docs/docIcons";
import { type DocTree, docsApi } from "@/docs/docsApi";
import { fuzzyScore } from "@/docs/fuzzy";
import { refreshAll } from "@/lib/query";
import { useBoard } from "./boardContext";
import type { addCard } from "./boardModel";
import { addImage, addLink, asUrl } from "./media";

type NewCard = Parameters<typeof addCard>[2];

export interface BoardToolbarProps {
  orgId: string;
  boardId: string;
  tree: DocTree;
  canEdit: boolean;
  /** The board's folder: new docs made from the board go there. */
  folder: string;
  onAddDoc: (docId: string, at?: { x: number; y: number }, expanded?: boolean) => void;
  onAdd: (card: NewCard) => void;
  showLinks: boolean;
  setShowLinks: (on: boolean) => void;
  showComments: boolean;
  setShowComments: (on: boolean) => void;
  undo: Y.UndoManager;
}

type Popup = "doc" | "link" | null;

/** Add notes, docs, columns, links and pictures; show or hide the arrows for links and comments; undo and redo. */
export function BoardToolbar(props: BoardToolbarProps) {
  const { canEdit, onAdd, undo } = props;
  const [popup, setPopup] = useState<Popup>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { doc, boardId } = useBoard();
  const flow = useReactFlow();
  const [, setStacks] = useState(0);

  // Undo and redo buttons follow what there is to undo.
  useEffect(() => {
    const bump = () => setStacks((n) => n + 1);
    undo.on("stack-item-added", bump);
    undo.on("stack-item-popped", bump);
    undo.on("stack-cleared", bump);
    return () => {
      undo.off("stack-item-added", bump);
      undo.off("stack-item-popped", bump);
      undo.off("stack-cleared", bump);
    };
  }, [undo]);

  const centre = () => {
    const { x, y, zoom } = flow.getViewport();
    const box = document.querySelector(".board-canvas")?.getBoundingClientRect();
    return { x: (-x + (box?.width ?? 800) / 2) / zoom - 130, y: (-y + (box?.height ?? 600) / 2) / zoom - 100 };
  };

  const run = (work: Promise<unknown>) =>
    work.then(
      () => setError(null),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );

  return (
    <Panel position="top-left" className="board-toolbar-wrap">
      <div className="board-toolbar">
        {canEdit && (
          <>
            <Tool title="Note (or double-click the board)" onClick={() => onAdd({ type: "note" })}>
              <StickyNote />
            </Tool>
            <Tool title="Add a doc" active={popup === "doc"} onClick={() => setPopup(popup === "doc" ? null : "doc")}>
              <FileText />
            </Tool>
            <Tool title="Column" onClick={() => onAdd({ type: "column", title: "Column" })}>
              <Columns3 />
            </Tool>
            <Tool
              title="Link to a web page"
              active={popup === "link"}
              onClick={() => setPopup(popup === "link" ? null : "link")}
            >
              <Link2 />
            </Tool>
            <Tool title="Picture" onClick={() => file.current?.click()}>
              <Image />
            </Tool>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                e.target.value = "";
                if (picked) void run(addImage(doc, boardId, picked, centre()));
              }}
            />
            <span className="board-toolbar-gap" />
          </>
        )}
        <Tool
          title="Arrows for [[links]] between docs"
          active={props.showLinks}
          onClick={() => props.setShowLinks(!props.showLinks)}
        >
          <Network />
        </Tool>
        <Tool
          title="Page comments the docs link to"
          active={props.showComments}
          onClick={() => props.setShowComments(!props.showComments)}
        >
          <MessageSquare />
        </Tool>
        {canEdit && (
          <>
            <span className="board-toolbar-gap" />
            <Tool title="Undo (Ctrl Z)" disabled={undo.undoStack.length === 0} onClick={() => undo.undo()}>
              <Undo2 />
            </Tool>
            <Tool title="Redo (Ctrl Shift Z)" disabled={undo.redoStack.length === 0} onClick={() => undo.redo()}>
              <Redo2 />
            </Tool>
          </>
        )}
      </div>
      {popup === "doc" && <DocPicker {...props} onError={setError} onDone={() => setPopup(null)} />}
      {popup === "link" && (
        <LinkForm
          onSubmit={(url) => {
            setPopup(null);
            void run(addLink(doc, boardId, url, centre()));
          }}
        />
      )}
      {error && <p className="board-toolbar-error">{error}</p>}
    </Panel>
  );
}

function Tool({
  title,
  onClick,
  active,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn("board-tool", active && "board-tool-active")}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Find a doc to put on the board, or make a new one there. */
function DocPicker({
  orgId,
  tree,
  boardId,
  folder,
  onAddDoc,
  onError,
  onDone,
}: BoardToolbarProps & { onError: (message: string | null) => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const found = useMemo(() => {
    const docs = [...tree.docs, ...(tree.shared ?? []).map((d) => ({ ...d, folder: d.from.name, tags: [] }))].filter(
      (d) => d.id !== boardId,
    );
    if (!q.trim()) return [...docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
    return docs
      .map((d) => ({ d, score: fuzzyScore(q, d.title) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 8)
      .map((x) => x.d);
  }, [q, tree, boardId]);
  const exact = tree.docs.some((d) => d.title.toLowerCase() === q.trim().toLowerCase() && d.folder === folder);

  const create = async () => {
    try {
      const created = await docsApi.create(orgId, q.trim(), folder);
      await refreshAll();
      onAddDoc(created.id, undefined, true);
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="board-popup">
      <Input
        autoFocus
        className="h-8"
        placeholder="Find a doc, or type a new title"
        aria-label="Find a doc"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
          if (e.key === "Enter" && found[0]) {
            onAddDoc(found[0].id);
            onDone();
          }
        }}
      />
      <ul className="mt-1 max-h-72 overflow-y-auto">
        {found.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => {
                onAddDoc(d.id);
                onDone();
              }}
            >
              <DocIcon
                icon={d.icon}
                kind={d.kind}
                color={d.color}
                className={cn("size-4 shrink-0", !d.color && "text-muted-foreground")}
              />
              <span className="truncate">{d.title}</span>
              {d.folder && <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{d.folder}</span>}
            </button>
          </li>
        ))}
        {q.trim() && !exact && (
          <li>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => void create()}
            >
              <FilePlus2 className="size-4 shrink-0 text-muted-foreground" />
              New doc “{q.trim()}”{folder && <span className="text-xs text-muted-foreground"> in {folder}</span>}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

function LinkForm({ onSubmit }: { onSubmit: (url: string) => void }) {
  const [value, setValue] = useState("");
  const url = asUrl(value);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url) onSubmit(url);
  };
  return (
    <form className="board-popup" onSubmit={submit}>
      <Input
        autoFocus
        className="h-8"
        placeholder="https://…"
        aria-label="Web address"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <p className="mt-1 px-1 text-xs text-muted-foreground">
        {url || !value
          ? "Press Enter to add it. You can also paste a link straight onto the board."
          : "That isn't a web address."}
      </p>
    </form>
  );
}

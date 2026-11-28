import { Button } from "@inklayer/ui/components/button";
import { Input } from "@inklayer/ui/components/input";
import { cn } from "@inklayer/ui/lib/utils";
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  Folder,
  FolderPlus,
  LayoutDashboard,
  Pencil,
  Trash2,
} from "lucide-react";
import { type DragEvent, type FormEvent, type ReactNode, useRef, useState } from "react";
import { useMe } from "@/App";
import { Link } from "@/lib/router";
import { DocIcon } from "../docIcons";
import { type DocSummary, docPath } from "../docsApi";
import { pathOf } from "../links";
import { DRAG_DOC, DRAG_FOLDER, type Draft, type FolderNode, INDENT_PX, isEmpty } from "./folders";

export interface FolderTreeProps {
  node: FolderNode;
  depth: number;
  orgId: string;
  activeId?: string;
  open: Set<string>;
  toggle: (path: string) => void;
  draft: Draft;
  setDraft: (draft: Draft) => void;
  canEdit: boolean;
  onSubmitDraft: (value: string) => void;
  onDrop: (folder: string) => (e: DragEvent) => void;
  onDeleteFolder: (path: string) => void;
}

/** A folder's contents: its folders (each with its own contents when open), then its docs. */
export function FolderChildren(props: FolderTreeProps) {
  const { node, depth, orgId, activeId, canEdit } = props;
  return (
    <>
      {node.folders.map((folder) => (
        <FolderItem key={folder.path} {...props} folder={folder} />
      ))}
      {node.docs.map((doc) => (
        <DocRow key={doc.id} orgId={orgId} doc={doc} active={doc.id === activeId} depth={depth} draggable={canEdit} />
      ))}
    </>
  );
}

/** One folder: its row (or the box to rename it), and when open, a new doc/folder box and its contents. */
function FolderItem(props: FolderTreeProps & { folder: FolderNode }) {
  const { folder, depth, open, draft, setDraft, onSubmitDraft } = props;
  const isOpen = open.has(folder.path.toLowerCase());
  const renaming = draft?.kind === "rename" && draft.path === folder.path;
  const creatingHere = draft && draft.kind !== "rename" && draft.parent === folder.path;
  return (
    <div>
      {renaming ? (
        <DraftInput
          kind="folder"
          depth={depth}
          initial={folder.name}
          onSubmit={onSubmitDraft}
          onCancel={() => setDraft(null)}
        />
      ) : (
        <FolderRow {...props} isOpen={isOpen} />
      )}
      {isOpen && (
        <>
          {creatingHere && (
            <DraftInput kind={draft.kind} depth={depth + 1} onSubmit={onSubmitDraft} onCancel={() => setDraft(null)} />
          )}
          <FolderChildren {...props} node={folder} depth={depth + 1} />
        </>
      )}
    </div>
  );
}

/** A folder's row: open/close it, drag it, drop docs and folders on it; on hover, new doc/folder, rename and delete. */
function FolderRow({
  folder,
  depth,
  isOpen,
  toggle,
  setDraft,
  canEdit,
  onDrop,
  onDeleteFolder,
}: FolderTreeProps & { folder: FolderNode; isOpen: boolean }) {
  const { me } = useMe();
  const createHere = (kind: "doc" | "board" | "folder") => {
    setDraft({ kind, parent: folder.path });
    if (!isOpen) toggle(folder.path);
  };
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  return (
    <div
      className="group flex items-center rounded-md hover:bg-muted"
      style={{ paddingLeft: depth * INDENT_PX }}
      draggable={canEdit}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_FOLDER, folder.path)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.stopPropagation();
        onDrop(folder.path)(e);
      }}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-sm"
        onClick={() => toggle(folder.path)}
      >
        <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
        <Folder className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{folder.name}</span>
      </button>
      {canEdit && (
        <span className="hidden shrink-0 items-center pr-1 group-hover:flex">
          <IconButton small title="New doc here" onClick={() => createHere("doc")}>
            <FilePlus2 />
          </IconButton>
          {me.features.boards && (
            <IconButton small title="New board here" onClick={() => createHere("board")}>
              <LayoutDashboard />
            </IconButton>
          )}
          <IconButton small title="New folder here" onClick={() => createHere("folder")}>
            <FolderPlus />
          </IconButton>
          <IconButton small title="Rename" onClick={() => setDraft({ kind: "rename", path: folder.path })}>
            <Pencil />
          </IconButton>
          {isEmpty(folder) && (
            <IconButton small title="Delete empty folder" onClick={() => onDeleteFolder(folder.path)}>
              <Trash2 />
            </IconButton>
          )}
        </span>
      )}
    </div>
  );
}

/** A doc in the sidebar: its icon and title, linked; draggable into folders. */
export function DocRow({
  orgId,
  doc,
  active,
  depth,
  draggable,
  showFolder,
}: {
  orgId: string;
  doc: DocSummary;
  active: boolean;
  depth: number;
  draggable?: boolean;
  showFolder?: boolean;
}) {
  return (
    <Link
      to={docPath(orgId, doc.id)}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_DOC, doc.id)}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm",
        active ? "bg-primary/12 font-medium text-foreground" : "text-foreground/85 hover:bg-muted",
      )}
      style={{ paddingLeft: depth * INDENT_PX + 22 }}
      title={pathOf(doc)}
    >
      <DocIcon
        icon={doc.icon}
        kind={doc.kind}
        color={doc.color}
        className={cn("size-3.5 shrink-0", !doc.color && "text-muted-foreground")}
      />
      <span className="truncate">{doc.title}</span>
      {showFolder && doc.folder && (
        <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{doc.folder}</span>
      )}
    </Link>
  );
}

/** A box for a new doc's title or a folder's name. Enter saves; Escape cancels; leaving it saves if it changed. */
export function DraftInput({
  kind,
  depth,
  initial = "",
  onSubmit,
  onCancel,
}: {
  kind: "doc" | "board" | "folder";
  depth: number;
  initial?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false); // Enter submits; the blur that follows mustn't submit again
  const finish = (submitIt: boolean) => {
    if (done.current) return;
    done.current = true;
    if (submitIt) onSubmit(value);
    else onCancel();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    finish(true);
  };
  return (
    <form onSubmit={submit} className="py-0.5" style={{ paddingLeft: depth * INDENT_PX + 4 }}>
      <Input
        autoFocus
        className="h-7 text-sm"
        placeholder={kind === "doc" ? "Doc title" : kind === "board" ? "Board title" : "Folder name"}
        aria-label={kind === "doc" ? "New doc title" : kind === "board" ? "New board title" : "Folder name"}
        value={value}
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(value.trim() !== "" && value !== initial)}
        onKeyDown={(e) => e.key === "Escape" && finish(false)}
      />
    </form>
  );
}

/** A small icon-only button in the sidebar, labelled by its title. */
export function IconButton({
  title,
  onClick,
  children,
  small,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  small?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={small ? "size-6 [&_svg]:size-3.5" : "size-8"}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

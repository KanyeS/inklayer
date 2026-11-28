import { createEditor } from "@inklayer/docs/editor";
import { renderMarkdown } from "@inklayer/docs/reading";
import { cn } from "@inklayer/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Handle, type Node, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { ExternalLink, Maximize2, MessageSquare, Minimize2, Palette, SquareKanban } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { DocSession } from "@/docs/collab";
import { taskHooks, taskHref } from "@/docs/doc-view/taskLinks";
import { DocIcon } from "@/docs/docIcons";
import { docPath } from "@/docs/docsApi";
import { resolveLink } from "@/docs/links";
import { KanbanOnBoard } from "@/kanban/KanbanOnBoard";
import { kanbanQueries } from "@/kanban/kanbanApi";
import type { Task } from "@/kanban/kanbanModel";
import { Avatars } from "@/kanban/pickers";
import { DueChip, PriorityIcon, TypeIcon } from "@/kanban/TaskCard";
import { lookupPeople } from "@/lib/api";
import { navigate } from "@/lib/router";
import type { BoardDoc } from "./boardApi";
import { useBoard } from "./boardContext";
import {
  addCard,
  CARD_SIZES,
  type Card,
  type ColumnCard,
  type DocCard,
  EXPANDED_DOC_SIZE,
  type ImageCard,
  KANBAN_CARD_SIZE,
  type LinkCard,
  LOCAL,
  NOTE_COLORS,
  type NoteCard,
  type TaskCard,
  updateCard,
} from "./boardModel";
import { setText, shiftPosition } from "./noteText";

/** What a card's node carries: the card as stored. */
export type CardNode = Node<{ card: Card }, Card["type"]>;

/** A comment linked from a doc on the board: drawn beside the doc, not stored on the board. */
export type CommentNode = Node<{ annotationId: string; label: string; status?: string }, "comment">;

export type BoardNode = CardNode | CommentNode;

/** Handles on all four sides; with loose connections any of them starts or ends an arrow. */
function Handles() {
  return (
    <>
      {[Position.Top, Position.Right, Position.Bottom, Position.Left].map((p) => (
        <Handle key={p} id={p} type="source" position={p} className="board-handle" />
      ))}
    </>
  );
}

/** A card's frame: the outline others' selections show in, handles for arrows, and the resize grips when selected. */
function Frame({
  id,
  selected,
  minWidth = 140,
  minHeight = 60,
  className,
  style,
  children,
}: {
  id: string;
  selected: boolean;
  minWidth?: number;
  minHeight?: number;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const { doc, canEdit, selectedBy } = useBoard();
  const others = selectedBy.get(id);
  return (
    <>
      {canEdit && (
        <NodeResizer
          isVisible={selected}
          minWidth={minWidth}
          minHeight={minHeight}
          lineClassName="board-resize-line"
          handleClassName="board-resize-handle"
          onResizeEnd={(_, p) => updateCard(doc, id, { x: p.x, y: p.y, w: p.width, h: p.height })}
        />
      )}
      {others?.length ? (
        <div className="board-selected-by" aria-hidden="true">
          {others.map((o) => (
            <span key={o.name + o.color} style={{ background: o.color }}>
              {o.name}
            </span>
          ))}
        </div>
      ) : null}
      <div
        className={cn("board-card", selected && "board-card-selected", className)}
        style={{
          ...style,
          ...(others?.length
            ? { boxShadow: others.map((o, i) => `0 0 0 ${2 + i * 2}px ${o.color}`).join(", ") }
            : null),
        }}
      >
        {children}
      </div>
      {canEdit && <Handles />}
    </>
  );
}

/* ------------------------------------------------------------------ doc cards */

export function DocCardNode({ id, data, selected }: NodeProps<CardNode>) {
  const card = data.card as DocCard;
  const { doc, docs, docsLoaded, canEdit, openDoc, tree, orgId } = useBoard();
  const info = docs.get(card.docId);
  const isKanban = info?.kind === "kanban";
  const expanded = !!card.expanded && !!info && (info.kind === "doc" || isKanban);
  const big = isKanban ? KANBAN_CARD_SIZE : EXPANDED_DOC_SIZE;

  const toggle = () =>
    updateCard(doc, id, {
      expanded: expanded ? undefined : true,
      ...(expanded
        ? { w: CARD_SIZES.doc.w, h: CARD_SIZES.doc.h }
        : { w: Math.max(card.w, big.w), h: Math.max(card.h, big.h) }),
    });

  // A task opened from the kanban, pinned beside it.
  const pinTask = (task: Task) =>
    addCard(
      doc,
      { x: card.x + card.w + 24, y: card.y },
      { type: "task", kanbanId: card.docId, taskId: task.id, key: task.key },
    );

  const preview = useMemo(
    () =>
      info?.excerpt
        ? renderMarkdown(info.excerpt, {
            doc: (link) => {
              const target = resolveLink(tree.docs, link);
              return target ? { href: docPath(orgId, target.id) } : null;
            },
          })
        : "",
    [info?.excerpt, tree, orgId],
  );

  if (!info) {
    return (
      <Frame id={id} selected={selected} className="board-doc-card">
        <div className="p-3 text-sm text-muted-foreground">
          {docsLoaded ? "This doc was deleted, or you can't open it." : "Loading…"}
        </div>
      </Frame>
    );
  }

  return (
    <Frame
      id={id}
      selected={selected}
      minWidth={expanded ? 320 : 160}
      minHeight={expanded ? 240 : 80}
      className={cn("board-doc-card", expanded && "board-doc-card-open")}
      style={expanded ? { height: "100%" } : undefined}
    >
      <div className={cn("board-card-header", expanded && "board-drag")}>
        <DocIcon
          icon={info.icon}
          kind={info.kind}
          color={info.color}
          className={cn("size-4 shrink-0", !info.color && "text-muted-foreground")}
        />
        <button
          type="button"
          className="nodrag min-w-0 flex-1 truncate text-left font-medium hover:underline"
          title={info.folder ? `${info.folder}/${info.title}` : info.title}
          onClick={(e) => openDoc(info.id, e.metaKey || e.ctrlKey)}
        >
          {info.title}
        </button>
        {(info.kind === "doc" || isKanban) && (
          <CardButton
            title={
              isKanban ? (expanded ? "Show less" : "Show its columns here") : expanded ? "Show a preview" : "Edit here"
            }
            onClick={toggle}
            disabled={!canEdit && !expanded}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </CardButton>
        )}
        <CardButton title="Open the doc" onClick={() => openDoc(info.id)}>
          <ExternalLink />
        </CardButton>
      </div>
      <DocCardBody
        info={info}
        expanded={expanded}
        preview={preview}
        canEdit={canEdit}
        onToggle={toggle}
        onPin={canEdit ? pinTask : undefined}
      />
    </Frame>
  );
}

/** Under a doc card's header: its live editor or kanban, or a preview. */
function DocCardBody({
  info,
  expanded,
  preview,
  canEdit,
  onToggle,
  onPin,
}: {
  info: BoardDoc;
  expanded: boolean;
  preview: string;
  canEdit: boolean;
  onToggle: () => void;
  onPin?: (task: Task) => void;
}) {
  const { orgId, tree } = useBoard();
  return (
    <>
      {expanded && info.kind === "kanban" ? (
        <KanbanOnBoard orgId={orgId} kanbanId={info.id} tree={tree} pinTask={onPin} />
      ) : expanded ? (
        <CardEditor docId={info.id} />
      ) : info.kind === "kanban" ? (
        <button
          type="button"
          className="nodrag px-3 pb-3 text-left text-sm text-muted-foreground hover:text-foreground"
          onClick={onToggle}
        >
          A kanban. Show its columns here, to move its tasks along.
        </button>
      ) : info.kind === "board" ? (
        <p className="px-3 pb-3 text-sm text-muted-foreground">A board. Open it to see its cards.</p>
      ) : preview ? (
        <div
          className="doc-reading board-doc-preview"
          onDoubleClick={() => canEdit && onToggle()}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: rendered by the docs package, which escapes HTML
          dangerouslySetInnerHTML={{ __html: preview }}
        />
      ) : (
        <p className="px-3 pb-3 text-sm text-muted-foreground" onDoubleClick={() => canEdit && onToggle()}>
          Empty.{canEdit && " Double-click to write."}
        </p>
      )}
    </>
  );
}

/** The doc's live editor, inside its card: the same editor and the same copy as the doc's own page. */
function CardEditor({ docId }: { docId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const { tree, orgId, measured } = useBoard();
  const treeRef = useRef(tree);
  treeRef.current = tree;
  // Read through refs, so the editor (and its live session) is made once per doc, not again on every board render.
  const measuredRef = useRef(measured);
  measuredRef.current = measured;
  const [status, setStatus] = useState("Connecting…");

  useEffect(() => {
    const session = new DocSession(docId);
    let editor: ReturnType<typeof createEditor> | null = null;
    const mount = () => {
      if (!session.loaded || editor || !host.current) return;
      setStatus("");
      editor = createEditor(host.current, session, {
        titles: () => treeRef.current.docs,
        openLink: (link, newTab) => {
          const target = resolveLink(treeRef.current.docs, link);
          if (!target) return;
          if (newTab) window.open(docPath(orgId, target.id), "_blank", "noopener");
          else navigate(docPath(orgId, target.id));
        },
        openComment: (id) => navigate(`/comments/${id}`),
        commentLabel: () => undefined,
        people: (q) => lookupPeople(orgId, q).catch(() => []),
        person: () => undefined,
        onPointer: () => undefined,
        ...taskHooks(orgId, () => editor?.refreshChips()),
      });
      measuredRef.current();
    };
    const off = session.subscribe(() => {
      if (session.status === "offline") setStatus(session.error || "Can't reach the server. Retrying…");
      mount();
      editor?.setEditable(session.canEdit);
    });
    void session.open().then(mount);
    return () => {
      off();
      editor?.destroy();
      void session.close();
    };
  }, [docId, orgId]);

  return (
    <div className="board-doc-editor nodrag nowheel nopan">
      {status && <p className="p-3 text-sm text-muted-foreground">{status}</p>}
      <div ref={host} className="doc-editor h-full" />
    </div>
  );
}

function CardButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="nodrag grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:hidden [&_svg]:size-3.5"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ notes */

/** A note's text, kept in step with the shared Y.Text; others' typing keeps this person's caret in place. */
function useSharedText(text: Y.Text, area: React.RefObject<HTMLTextAreaElement | null>) {
  const [value, setValue] = useState(() => text.toString());
  const caret = useRef<[number, number] | null>(null);
  useEffect(() => {
    const onChange = (event: Y.YTextEvent) => {
      const el = area.current;
      if (el && document.activeElement === el && event.transaction.origin !== LOCAL) {
        caret.current = [
          shiftPosition(el.selectionStart, event.delta as never),
          shiftPosition(el.selectionEnd, event.delta as never),
        ];
      }
      setValue(text.toString());
    };
    text.observe(onChange);
    setValue(text.toString());
    return () => text.unobserve(onChange);
  }, [text, area]);
  useLayoutEffect(() => {
    if (caret.current && area.current) {
      area.current.setSelectionRange(...caret.current);
      caret.current = null;
    }
  });
  return value;
}

export function NoteCardNode({ id, data, selected }: NodeProps<CardNode>) {
  const card = data.card as NoteCard;
  const { doc, canEdit } = useBoard();
  const area = useRef<HTMLTextAreaElement>(null);
  const value = useSharedText(card.text, area);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);

  return (
    <Frame id={id} selected={selected} className="board-note" style={{ background: card.color ?? NOTE_COLORS[0] }}>
      {canEdit && selected && (
        <div className="board-note-tools nodrag">
          <CardButton title="Colour" onClick={() => setPicking((p) => !p)}>
            <Palette />
          </CardButton>
          {picking &&
            NOTE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={cn("size-5 rounded-full border", c === card.color && "ring-2 ring-primary")}
                style={{ background: c }}
                aria-label={`Colour ${c}`}
                onClick={() => {
                  updateCard(doc, id, { color: c });
                  setPicking(false);
                }}
              />
            ))}
        </div>
      )}
      {editing && canEdit ? (
        <textarea
          ref={area}
          className="board-note-text nodrag nowheel"
          value={value}
          placeholder="Write a note"
          aria-label="Note"
          onChange={(e) => setText(card.text, e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            e.stopPropagation(); // Backspace and Delete edit the note, not the board
            if (e.key === "Escape") e.currentTarget.blur();
          }}
        />
      ) : (
        <div
          className={cn("board-note-text", !value && "text-black/40")}
          onDoubleClick={() => canEdit && setEditing(true)}
        >
          {value || (canEdit ? "Double-click to write" : "")}
        </div>
      )}
    </Frame>
  );
}

/* ------------------------------------------------------------------ images and links */

export function ImageCardNode({ id, data, selected }: NodeProps<CardNode>) {
  const card = data.card as ImageCard;
  const { boardId } = useBoard();
  return (
    <Frame id={id} selected={selected} minWidth={80} minHeight={60} className="board-image" style={{ height: "100%" }}>
      <img
        src={`/api/boards/${boardId}/media/${card.mediaId}`}
        alt={card.alt ?? ""}
        draggable={false}
        className="size-full rounded-[inherit] object-contain"
      />
    </Frame>
  );
}

/** Only http(s) links are opened or shown. */
export function safeHttpUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function LinkCardNode({ id, data, selected }: NodeProps<CardNode>) {
  const card = data.card as LinkCard;
  const href = safeHttpUrl(card.url);
  const image = safeHttpUrl(card.image);
  const host = href ? new URL(href).host : card.url;
  return (
    <Frame id={id} selected={selected} className="board-link">
      {image && <img src={image} alt="" draggable={false} className="board-link-image" referrerPolicy="no-referrer" />}
      <div className="p-3">
        <a
          href={href ?? undefined}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="nodrag line-clamp-2 font-medium hover:underline"
        >
          {card.title || host}
        </a>
        {card.description && <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{card.description}</p>}
        <p className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
          <ExternalLink className="size-3 shrink-0" />
          {host}
        </p>
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------ columns */

export function ColumnCardNode({ id, data, selected }: NodeProps<CardNode>) {
  const card = data.card as ColumnCard;
  const { doc, canEdit } = useBoard();
  const [title, setTitle] = useState(card.title);
  useEffect(() => setTitle(card.title), [card.title]);
  const save = () => {
    const next = title.trim() || "Column";
    setTitle(next);
    if (next !== card.title) updateCard(doc, id, { title: next });
  };
  return (
    <Frame
      id={id}
      selected={selected}
      minWidth={200}
      minHeight={120}
      className="board-column"
      style={{ height: "100%" }}
    >
      <input
        className="board-column-title nodrag"
        value={title}
        disabled={!canEdit}
        aria-label="Column title"
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
    </Frame>
  );
}

/* ------------------------------------------------------------------ tasks pinned from a kanban */

export function TaskCardNode({ id, data, selected }: NodeProps<CardNode>) {
  const card = data.card as TaskCard;
  const tasks = useQuery(kanbanQueries.boardTasks(card.kanbanId));
  const task = tasks.data?.find((t) => t.taskId === card.taskId);
  const people = useMemo(() => new Map((task?.assignees ?? []).map((p) => [p.id, p])), [task]);
  if (!task) {
    return (
      <Frame id={id} selected={selected} className="board-task-card">
        <p className="p-3 text-sm text-muted-foreground">
          {tasks.isFetched || tasks.error
            ? `${card.key || "This task"} was deleted, or you can't open its kanban.`
            : "Loading…"}
        </p>
      </Frame>
    );
  }
  const done = task.category === "done";
  return (
    <Frame id={id} selected={selected} minWidth={180} minHeight={70} className="board-task-card">
      <div
        className="flex h-full flex-col"
        onDoubleClick={() => navigate(taskHref(task))}
        title="Double-click to open it on its kanban"
      >
        <div className={cn("kanban-card", done && "kanban-card-done")}>
          <div className="kanban-card-title">{task.title}</div>
          <div className="kanban-card-foot">
            <TypeIcon type={task.type as Task["type"]} />
            <button
              type="button"
              className={cn("nodrag kanban-key hover:underline", done && "line-through")}
              onClick={() => navigate(taskHref(task))}
            >
              {task.key}
            </button>
            <span className="kanban-due">{task.column}</span>
            <span className="flex-1" />
            {task.due && <DueChip due={task.due} done={done} />}
            <PriorityIcon priority={task.priority as Task["priority"]} />
            <Avatars ids={task.assignees.map((a) => a.id)} people={people} size={20} />
          </div>
        </div>
        <div className="board-task-card-kanban">
          <SquareKanban className="size-3" /> {task.kanbanTitle}
        </div>
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------ comments linked from docs */

export function CommentNodeView({ data }: NodeProps<CommentNode>) {
  return (
    <div className={cn("board-comment", data.status === "Resolved" && "opacity-60")} title="Page comment">
      <Handle type="target" position={Position.Left} className="board-handle" isConnectable={false} />
      <MessageSquare className="size-3.5 shrink-0 text-amber-500" />
      <button
        type="button"
        className="nodrag min-w-0 flex-1 truncate text-left hover:underline"
        onClick={() => navigate(`/comments/${data.annotationId}`)}
      >
        {data.label}
      </button>
    </div>
  );
}

export const nodeTypes = {
  doc: DocCardNode,
  note: NoteCardNode,
  image: ImageCardNode,
  link: LinkCardNode,
  column: ColumnCardNode,
  task: TaskCardNode,
  comment: CommentNodeView,
};

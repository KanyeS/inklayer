import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@inklayer/ui/components/dropdown-menu";
import { cn } from "@inklayer/ui/lib/utils";
import { ArrowLeft, ArrowRight, Check, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { type KanbanPeer, type KanbanState, useKanbanContext, usePeersByTask } from "./kanbanContext";
import {
  addColumn,
  CATEGORIES,
  type Category,
  type Column,
  columnOf,
  isBlocked,
  moveColumn,
  moveTask,
  removeColumn,
  type Task,
  updateColumn,
  updateTask,
} from "./kanbanModel";
import { byRank } from "./ranks";
import { TaskCard } from "./TaskCard";

export type GroupBy = "none" | "assignee" | "epic";

export const CATEGORY_LABELS: Record<Category, string> = { todo: "To do", doing: "In progress", done: "Done" };

interface Lane {
  id: string;
  title: string;
  /** What a card dropped in this lane gets. */
  patch: { assignees?: string[]; parent?: string };
  /** Who a task is assigned to / under, to put it in this lane. */
  has: (task: Task) => boolean;
}

interface DropTarget {
  column: string;
  lane: string;
  index: number;
}

interface Drag {
  taskId: string;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  active: boolean;
}

export interface KanbanColumnsProps {
  state: KanbanState;
  /** Whether a task passes the toolbar's filters. */
  visible: (task: Task) => boolean;
  groupBy: GroupBy;
  selected: string | null;
  peers: KanbanPeer[];
  compact?: boolean;
}

/** The columns, side by side, with their cards; in swimlanes when grouped. Cards drag between columns and lanes. */
export function KanbanColumns({ state, visible, groupBy, selected, peers, compact }: KanbanColumnsProps) {
  const { doc, canEdit, people, openTask, session } = useKanbanContext();
  const { columns, tasks, relations } = state;
  const peersByTask = usePeersByTask(peers);

  const lanes = useMemo<Lane[]>(() => {
    const all = [...tasks.values()].filter(visible);
    if (groupBy === "assignee") {
      const ids = [...new Set(all.flatMap((t) => t.assignees.slice(0, 1)))];
      ids.sort((a, b) => (people.get(a)?.displayName ?? "~").localeCompare(people.get(b)?.displayName ?? "~"));
      return [
        ...ids.map((id) => ({
          id,
          title: people.get(id)?.displayName ?? "Someone",
          patch: { assignees: [id] },
          has: (t: Task) => t.assignees[0] === id,
        })),
        { id: "", title: "Unassigned", patch: { assignees: [] }, has: (t: Task) => t.assignees.length === 0 },
      ];
    }
    if (groupBy === "epic") {
      const epics = [...tasks.values()].filter((t) => t.type === "epic").sort(byRank);
      const epicOf = (t: Task) => (t.parent && tasks.get(t.parent)?.type === "epic" ? t.parent : "");
      return [
        ...epics.map((e) => ({
          id: e.id,
          title: `${e.key} ${e.title}`,
          patch: { parent: e.id },
          has: (t: Task) => epicOf(t) === e.id,
        })),
        { id: "", title: "No epic", patch: { parent: "" }, has: (t: Task) => epicOf(t) === "" && t.type !== "epic" },
      ];
    }
    return [{ id: "", title: "", patch: {}, has: () => true }];
  }, [groupBy, tasks, visible, people]);

  /** The visible tasks in each lane × column, in order. */
  const cells = useMemo(() => {
    const map = new Map<string, Task[]>();
    const ordered = [...tasks.values()].filter(visible).sort(byRank);
    for (const lane of lanes) {
      for (const column of columns) map.set(`${lane.id}|${column.id}`, []);
    }
    for (const task of ordered) {
      if (groupBy === "epic" && task.type === "epic") continue;
      const lane = lanes.find((l) => l.has(task));
      const column = columnOf(task, columns);
      if (lane && column) map.get(`${lane.id}|${column.id}`)?.push(task);
    }
    return map;
  }, [tasks, visible, lanes, columns, groupBy]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const task of tasks.values()) {
      const c = columnOf(task, columns);
      if (c) map.set(c.id, (map.get(c.id) ?? 0) + 1);
    }
    return map;
  }, [tasks, columns]);

  const subtaskCounts = useMemo(() => {
    const map = new Map<string, { done: number; total: number }>();
    for (const t of tasks.values()) {
      if (!t.parent) continue;
      const entry = map.get(t.parent) ?? { done: 0, total: 0 };
      entry.total++;
      if (columnOf(t, columns)?.category === "done") entry.done++;
      map.set(t.parent, entry);
    }
    return map;
  }, [tasks, columns]);

  /* ---------------------------------------------------------------- dragging cards */

  const drag = useRef<Drag | null>(null);
  const [ghost, setGhost] = useState<{ taskId: string; x: number; y: number; width: number } | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const targetRef = useRef<DropTarget | null>(null);
  const suppressClick = useRef(false);

  const setAwareness = (task: string | null, dragging: boolean) =>
    session?.shareAwareness && session.awareness.setLocalStateField("kanban", { task, dragging });

  // Tell others which task this person has open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the open task changes
  useEffect(() => {
    setAwareness(selected, false);
  }, [selected]);

  const targetAt = (x: number, y: number, draggedId: string): DropTarget | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-column]");
    if (!el) return null;
    const column = el.dataset.dropColumn ?? "";
    const lane = el.dataset.dropLane ?? "";
    const cards = [...el.querySelectorAll<HTMLElement>("[data-task-id]")].filter((c) => c.dataset.taskId !== draggedId);
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const box = cards[i]?.getBoundingClientRect();
      if (!box) continue;
      if (y < box.top + box.height / 2) {
        index = i;
        break;
      }
    }
    return { column, lane, index };
  };

  const onCardPointerDown = (e: PointerEvent<HTMLDivElement>, taskId: string) => {
    if (!canEdit || e.button !== 0 || (e.target as HTMLElement).closest("a,button:not([data-card]),input,textarea"))
      return;
    const box = e.currentTarget.getBoundingClientRect();
    drag.current = {
      taskId,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - box.left,
      offsetY: e.clientY - box.top,
      width: box.width,
      active: false,
    };
  };

  useEffect(() => {
    const onMove = (e: globalThis.PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
        d.active = true;
        setAwareness(d.taskId, true);
        document.body.classList.add("kanban-dragging");
      }
      setGhost({ taskId: d.taskId, x: e.clientX - d.offsetX, y: e.clientY - d.offsetY, width: d.width });
      const t = targetAt(e.clientX, e.clientY, d.taskId);
      targetRef.current = t;
      setTarget(t);
    };
    const onUp = (e: globalThis.PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      drag.current = null;
      if (!d.active) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      document.body.classList.remove("kanban-dragging");
      const t = targetRef.current;
      setGhost(null);
      setTarget(null);
      targetRef.current = null;
      setAwareness(selected, false);
      if (t) drop(d.taskId, t);
    };
    const onCancel = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.classList.remove("kanban-dragging");
      setGhost(null);
      setTarget(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  });

  const drop = (taskId: string, t: DropTarget) => {
    const list = (cells.get(`${t.lane}|${t.column}`) ?? []).filter((x) => x.id !== taskId);
    const before = list[t.index - 1]?.id ?? null;
    const after = list[t.index]?.id ?? null;
    doc.transact(() => {
      moveTask(doc, taskId, t.column, before, after);
      const lane = lanes.find((l) => l.id === t.lane);
      const task = tasks.get(taskId);
      if (!lane || !task || groupBy === "none") return;
      // Into someone's lane: they become the first assignee (others stay); into Unassigned: no one.
      if (lane.patch.assignees && !lane.has(task)) {
        updateTask(doc, taskId, {
          assignees: lane.id ? [lane.id, ...task.assignees.slice(1).filter((a) => a !== lane.id)] : [],
        });
      }
      if (lane.patch.parent !== undefined && !lane.has(task))
        updateTask(doc, taskId, { parent: lane.patch.parent || undefined });
    });
  };

  /* ---------------------------------------------------------------- keyboard */

  const onCardKey = (e: KeyboardEvent<HTMLDivElement>, taskId: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openTask(taskId);
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const move = arrows[e.key];
    if (!move) return;
    e.preventDefault();
    const cell = e.currentTarget.closest<HTMLElement>("[data-drop-column]");
    const row = cell?.parentElement;
    if (!cell || !row) return;
    const cards = [...cell.querySelectorAll<HTMLElement>("[data-task-id]")];
    const index = cards.indexOf(e.currentTarget);
    if (move[1] !== 0) {
      cards[Math.max(0, Math.min(cards.length - 1, index + move[1]))]?.focus();
      return;
    }
    const cellsInRow = [...row.querySelectorAll<HTMLElement>(":scope > [data-drop-column]")];
    let at = cellsInRow.indexOf(cell) + move[0];
    while (at >= 0 && at < cellsInRow.length) {
      const next = [...(cellsInRow[at]?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])];
      if (next.length) {
        next[Math.min(index, next.length - 1)]?.focus();
        return;
      }
      at += move[0];
    }
  };

  const ghostTask = ghost ? tasks.get(ghost.taskId) : undefined;
  const lanesShown = groupBy !== "none";

  return (
    <div className={cn("kanban-board", compact && "kanban-board-compact")}>
      <div
        className="kanban-header-row"
        style={{ gridTemplateColumns: `repeat(${columns.length}, var(--kanban-column-width)) auto` }}
      >
        {columns.map((column, i) => (
          <ColumnHeader
            key={column.id}
            column={column}
            columns={columns}
            index={i}
            count={counts.get(column.id) ?? 0}
            canEdit={canEdit && !compact}
          />
        ))}
        {canEdit && !compact && (
          <button
            type="button"
            className="kanban-add-column"
            title="Add a column"
            onClick={() => addColumn(doc, "New column", "doing", columns.at(-2)?.id ?? columns.at(-1)?.id)}
          >
            <Plus className="size-4" />
          </button>
        )}
      </div>
      {lanes.map((lane) => (
        <section key={lane.id || "none"} className={cn("kanban-lane", lanesShown && "kanban-lane-shown")}>
          {lanesShown && (
            <h3 className="kanban-lane-title">
              {lane.title}
              <span className="kanban-count">
                {columns.reduce((n, c) => n + (cells.get(`${lane.id}|${c.id}`)?.length ?? 0), 0)}
              </span>
            </h3>
          )}
          <div
            className="kanban-row"
            style={{ gridTemplateColumns: `repeat(${columns.length}, var(--kanban-column-width))` }}
          >
            {columns.map((column) => {
              const list = cells.get(`${lane.id}|${column.id}`) ?? [];
              const here = target && target.column === column.id && target.lane === lane.id;
              const over = column.wip !== undefined && (counts.get(column.id) ?? 0) > column.wip;
              return (
                <div
                  key={column.id}
                  className={cn("kanban-cell", here && "kanban-cell-target", over && "kanban-cell-over")}
                  data-drop-column={column.id}
                  data-drop-lane={lane.id}
                >
                  {list.map((task, i) => (
                    <div key={task.id}>
                      {here && target.index === i && <div className="kanban-placeholder" />}
                      {/* biome-ignore lint/a11y/useSemanticElements: a card that drags as well as opens; a <button> can't hold its layout */}
                      <div
                        role="button"
                        tabIndex={0}
                        data-task-id={task.id}
                        data-card
                        className={cn("kanban-card-wrap", ghost?.taskId === task.id && "kanban-card-lifted")}
                        onPointerDown={(e) => onCardPointerDown(e, task.id)}
                        onClick={() => !suppressClick.current && openTask(task.id)}
                        onKeyDown={(e) => onCardKey(e, task.id)}
                      >
                        <TaskCard
                          task={task}
                          columns={columns}
                          people={people}
                          parent={task.parent ? tasks.get(task.parent) : undefined}
                          subtasks={subtaskCounts.get(task.id) ?? { done: 0, total: 0 }}
                          blocked={isBlocked(task.id, relations, tasks, columns)}
                          peers={peersByTask.get(task.id)}
                          selected={selected === task.id}
                          compact={compact}
                        />
                      </div>
                    </div>
                  ))}
                  {here && target.index >= list.filter((t) => t.id !== ghost?.taskId).length && (
                    <div className="kanban-placeholder" />
                  )}
                  {canEdit && !compact && <QuickAdd column={column.id} lane={lane} />}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {ghost && ghostTask && (
        <div className="kanban-ghost" style={{ left: ghost.x, top: ghost.y, width: ghost.width }}>
          <TaskCard
            task={ghostTask}
            columns={columns}
            people={people}
            subtasks={subtaskCounts.get(ghostTask.id) ?? { done: 0, total: 0 }}
            blocked={false}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ a column's heading */

function ColumnHeader({
  column,
  columns,
  index,
  count,
  canEdit,
}: {
  column: Column;
  columns: Column[];
  index: number;
  count: number;
  canEdit: boolean;
}) {
  const { doc } = useKanbanContext();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.name);
  const over = column.wip !== undefined && count > column.wip;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setRenaming(false);
    if (name.trim() && name.trim() !== column.name) updateColumn(doc, column.id, { name });
  };
  const left = columns[index - 1];
  const right = columns[index + 1];
  const neighbour = left ?? right;
  return (
    <div className={cn("kanban-column-header", `kanban-column-${column.category}`)}>
      {renaming ? (
        <form onSubmit={submit} className="min-w-0 flex-1">
          <input
            // biome-ignore lint/a11y/noAutofocus: opened by double-clicking the name, to type it
            autoFocus
            className="kanban-column-rename"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => submit()}
            onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
          />
        </form>
      ) : (
        <h2
          className="kanban-column-name"
          onDoubleClick={() => {
            if (!canEdit) return;
            setName(column.name);
            setRenaming(true);
          }}
        >
          {column.name}
        </h2>
      )}
      <span
        className={cn("kanban-count", over && "kanban-count-over")}
        title={column.wip ? `Limit: ${column.wip}` : undefined}
      >
        {count}
        {column.wip !== undefined && ` / ${column.wip}`}
      </span>
      {column.category === "done" && <Check className="size-3.5 text-emerald-600" aria-label="Done column" />}
      {canEdit && (
        <DropdownMenu>
          <DropdownMenuTrigger className="kanban-column-menu" aria-label={`${column.name}: column actions`}>
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                setName(column.name);
                setRenaming(true);
              }}
            >
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const value = window.prompt(
                  "At most how many tasks in this column? Leave empty for no limit.",
                  column.wip ? String(column.wip) : "",
                );
                if (value === null) return;
                updateColumn(doc, column.id, { wip: Number.parseInt(value, 10) || undefined });
              }}
            >
              Limit cards (WIP)…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Counts as</DropdownMenuLabel>
            {CATEGORIES.map((c) => (
              <DropdownMenuItem key={c} onClick={() => updateColumn(doc, column.id, { category: c })}>
                {column.category === c ? <Check /> : <span className="size-4" />} {CATEGORY_LABELS[c]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!left}
              onClick={() => left && moveColumn(doc, column.id, columns[index - 2]?.id ?? null, left.id)}
            >
              <ArrowLeft /> Move left
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!right}
              onClick={() => right && moveColumn(doc, column.id, right.id, columns[index + 2]?.id ?? null)}
            >
              <ArrowRight /> Move right
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                addColumn(doc, "New column", column.category === "done" ? "doing" : column.category, column.id)
              }
            >
              <Plus /> Add a column after
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={!neighbour}
              onClick={() => {
                if (!neighbour) return;
                if (
                  count > 0 &&
                  !window.confirm(
                    `Delete "${column.name}"? Its ${count} task${count === 1 ? "" : "s"} move to "${neighbour.name}".`,
                  )
                )
                  return;
                removeColumn(doc, column.id, neighbour.id);
              }}
            >
              <Trash2 /> Delete column
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ adding a task */

function QuickAdd({ column, lane }: { column: string; lane: Lane }) {
  const { createTask } = useKanbanContext();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await createTask({
        title,
        column,
        assignees: lane.patch.assignees,
        parent: lane.patch.parent || undefined,
      });
      setTitle("");
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button type="button" className="kanban-quick-add" data-quick-add={column} onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> Create
      </button>
    );
  return (
    <form onSubmit={submit} className="kanban-quick-form">
      <textarea
        // biome-ignore lint/a11y/noAutofocus: opened by pressing Create (or C), to type the task
        autoFocus
        rows={2}
        className="kanban-quick-input"
        placeholder="What needs doing?"
        value={title}
        maxLength={500}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) void submit(e);
          if (e.key === "Escape") setOpen(false);
        }}
        onBlur={() => !title.trim() && setOpen(false)}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">Enter to add, Esc to close</p>
    </form>
  );
}

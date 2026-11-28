import { formatDay } from "@inklayer/ui/components/date-picker";
import { cn } from "@inklayer/ui/lib/utils";
import {
  BookOpen,
  Bug,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  CircleCheck,
  Equal,
  ExternalLink,
  FileText,
  Hand,
  ListTree,
  Zap,
} from "lucide-react";
import type { KanbanPerson } from "./kanbanApi";
import type { KanbanPeer } from "./kanbanContext";
import { type Column, columnOf, dueState, type Priority, type Task, type TaskType } from "./kanbanModel";
import { Avatars } from "./pickers";

export const TYPE_LABELS: Record<TaskType, string> = { task: "Task", bug: "Bug", story: "Story", epic: "Epic" };
export const PRIORITY_LABELS: Record<Priority, string> = {
  highest: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
  lowest: "Lowest",
};

export function TypeIcon({ type, className }: { type: TaskType; className?: string }) {
  const Icon = type === "bug" ? Bug : type === "story" ? BookOpen : type === "epic" ? Zap : CircleCheck;
  return (
    <span className={cn("kanban-type", `kanban-type-${type}`, className)} title={TYPE_LABELS[type]}>
      <Icon />
    </span>
  );
}

export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const Icon =
    priority === "highest"
      ? ChevronsUp
      : priority === "high"
        ? ChevronUp
        : priority === "low"
          ? ChevronDown
          : priority === "lowest"
            ? ChevronsDown
            : Equal;
  return (
    <span
      className={cn("kanban-priority", `kanban-priority-${priority}`, className)}
      title={`${PRIORITY_LABELS[priority]} priority`}
    >
      <Icon />
    </span>
  );
}

export function DueChip({ due, done }: { due: string; done: boolean }) {
  const state = dueState(due, done);
  return (
    <span
      className={cn("kanban-due", `kanban-due-${state}`)}
      title={state === "overdue" ? "Overdue" : `Due ${formatDay(due)}`}
    >
      {formatDay(due)}
    </span>
  );
}

export interface TaskCardProps {
  task: Task;
  columns: Column[];
  people: Map<string, KanbanPerson>;
  parent?: Task;
  subtasks: { done: number; total: number };
  blocked: boolean;
  peers?: KanbanPeer[];
  selected?: boolean;
  compact?: boolean;
}

/** A task as a card in its column: key, title, and what matters at a glance. */
export function TaskCard({
  task,
  columns,
  people,
  parent,
  subtasks,
  blocked,
  peers,
  selected,
  compact,
}: TaskCardProps) {
  const done = columnOf(task, columns)?.category === "done";
  const ring = peers?.[0]?.color;
  return (
    <div
      className={cn(
        "kanban-card",
        done && "kanban-card-done",
        selected && "kanban-card-selected",
        compact && "kanban-card-compact",
      )}
      style={ring ? { boxShadow: `0 0 0 2px ${ring}` } : undefined}
    >
      {peers && peers.length > 0 && (
        <span className="kanban-card-peer" style={{ background: ring }}>
          {peers.map((p) => p.name).join(", ")}
          {peers.some((p) => p.dragging) && " (moving)"}
        </span>
      )}
      {parent && (
        <div className="kanban-card-parent" title={`Sub-task of ${parent.key} ${parent.title}`}>
          <ListTree className="size-3" />
          <span className="truncate">
            {parent.key} {parent.title}
          </span>
        </div>
      )}
      <div className="kanban-card-title">{task.title || <span className="text-muted-foreground">Untitled</span>}</div>
      {!compact && task.tags.length > 0 && (
        <div className="kanban-card-tags">
          {task.tags.slice(0, 4).map((t) => (
            <span key={t} className="kanban-tag">
              {t}
            </span>
          ))}
          {task.tags.length > 4 && <span className="kanban-tag">+{task.tags.length - 4}</span>}
        </div>
      )}
      <div className="kanban-card-foot">
        <TypeIcon type={task.type} />
        <span className={cn("kanban-key", done && "line-through")}>{task.key}</span>
        {blocked && (
          <span className="kanban-blocked" title="Blocked by a task that isn't done">
            <Hand className="size-3" />
          </span>
        )}
        {task.docId && <FileText className="size-3.5 text-muted-foreground" aria-label="Has a doc" />}
        {task.extKey && (
          <span className="kanban-ext" title={`Synced with ${task.extKey}`}>
            <ExternalLink className="size-3" />
            {task.extKey}
          </span>
        )}
        {subtasks.total > 0 && (
          <span className="kanban-subtasks" title={`${subtasks.done} of ${subtasks.total} sub-tasks done`}>
            <ListTree className="size-3" />
            {subtasks.done}/{subtasks.total}
          </span>
        )}
        <span className="flex-1" />
        {task.due && <DueChip due={task.due} done={done} />}
        <PriorityIcon priority={task.priority} />
        <Avatars ids={task.assignees} people={people} size={22} />
      </div>
    </div>
  );
}

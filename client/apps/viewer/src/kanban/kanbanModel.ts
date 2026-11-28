/**
 * A kanban's Yjs document: its columns, tasks and the links between tasks. The server only relays the bytes, but it reads
 * them too (server/src/Inklayer.Api/Features/Kanban/KanbanDoc.cs), for "My tasks", reminders and the Jira sync: the two
 * must agree on these names.
 *
 * - `columns`: id → Y.Map of `name`, `category` (todo, doing, done), `rank`, optional `wip` (a limit on cards).
 * - `tasks`: id → Y.Map of `key` (WEB-12), `title`, `description` (a Y.Text of markdown, so two people can write in it at
 *   once), `column`, `rank`, `type`, `priority`, `assignees` and `tags` (plain lists), and optional `reporter`, `due` and
 *   `start` (yyyy-mm-dd), `estimate`, `parent` (a sub-task's parent task), `docId` (the doc it links to, or became), `extId`,
 *   `extKey`, `extUrl` (the Jira issue it's synced with), `createdAt`, `createdBy`, `updatedAt`.
 * - `relations`: id → Y.Map of `from`, `to` and `type`: blocks, relates, duplicates or clones. The other direction
 *   ("is blocked by") is worked out when shown.
 *
 * Order is by `rank` (see ranks.ts), then id. Every change goes through the functions here, in one transaction each with
 * the `LOCAL` origin, so it's one step to undo and one update to send.
 */

import * as Y from "yjs";
import { byRank, rankBetween } from "./ranks";

export type Category = "todo" | "doing" | "done";
export type TaskType = "task" | "bug" | "story" | "epic";
export type Priority = "highest" | "high" | "medium" | "low" | "lowest";
export type RelationType = "blocks" | "relates" | "duplicates" | "clones";

export const TASK_TYPES: TaskType[] = ["task", "bug", "story", "epic"];
export const PRIORITIES: Priority[] = ["highest", "high", "medium", "low", "lowest"];
export const RELATION_TYPES: RelationType[] = ["blocks", "relates", "duplicates", "clones"];
export const CATEGORIES: Category[] = ["todo", "doing", "done"];

export interface Column {
  id: string;
  name: string;
  category: Category;
  rank: string;
  wip?: number;
}

export interface Task {
  id: string;
  key: string;
  title: string;
  /** Null only for a task written by a much older version; editing it adds one. */
  description: Y.Text | null;
  column: string;
  rank: string;
  type: TaskType;
  priority: Priority;
  assignees: string[];
  tags: string[];
  reporter?: string;
  due?: string;
  start?: string;
  estimate?: number;
  parent?: string;
  docId?: string;
  extId?: string;
  extKey?: string;
  extUrl?: string;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
}

export interface Relation {
  id: string;
  from: string;
  to: string;
  type: RelationType;
}

/** Undoable changes are made with this origin; others' arrive with the hub's. */
export const LOCAL = Symbol("kanban-local");

export const columnsOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("columns");
export const tasksOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("tasks");
export const relationsOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("relations");

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T =>
  values.includes(v as T) ? (v as T) : fallback;

export function newId(): string {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------ reading */

export function readColumns(doc: Y.Doc): Column[] {
  const columns: Column[] = [];
  for (const [id, map] of columnsOf(doc)) {
    if (!(map instanceof Y.Map)) continue;
    const wip = map.get("wip");
    columns.push({
      id,
      name: str(map.get("name")) ?? "Column",
      category: oneOf(map.get("category"), CATEGORIES, "todo"),
      rank: str(map.get("rank")) ?? "",
      wip: typeof wip === "number" && wip > 0 ? wip : undefined,
    });
  }
  return columns.sort(byRank);
}

export function readTask(id: string, map: Y.Map<unknown>): Task {
  const description = map.get("description");
  const estimate = map.get("estimate");
  return {
    id,
    key: str(map.get("key")) ?? "",
    title: str(map.get("title")) ?? "",
    description: description instanceof Y.Text ? description : null,
    column: str(map.get("column")) ?? "",
    rank: str(map.get("rank")) ?? "",
    type: oneOf(map.get("type"), TASK_TYPES, "task"),
    priority: oneOf(map.get("priority"), PRIORITIES, "medium"),
    assignees: strings(map.get("assignees")),
    tags: strings(map.get("tags")),
    reporter: str(map.get("reporter")),
    due: str(map.get("due")),
    start: str(map.get("start")),
    estimate: typeof estimate === "number" ? estimate : undefined,
    parent: str(map.get("parent")),
    docId: str(map.get("docId")),
    extId: str(map.get("extId")),
    extKey: str(map.get("extKey")),
    extUrl: str(map.get("extUrl")),
    createdAt: str(map.get("createdAt")),
    createdBy: str(map.get("createdBy")),
    updatedAt: str(map.get("updatedAt")),
  };
}

/** Every task, by id. Parents that are gone are dropped (the task stands on its own). */
export function readTasks(doc: Y.Doc): Map<string, Task> {
  const tasks = new Map<string, Task>();
  for (const [id, map] of tasksOf(doc)) if (map instanceof Y.Map) tasks.set(id, readTask(id, map));
  for (const task of tasks.values()) if (task.parent && !tasks.has(task.parent)) task.parent = undefined;
  return tasks;
}

export function readRelations(doc: Y.Doc, tasks?: Map<string, Task>): Relation[] {
  const relations: Relation[] = [];
  for (const [id, map] of relationsOf(doc)) {
    if (!(map instanceof Y.Map)) continue;
    const from = str(map.get("from"));
    const to = str(map.get("to"));
    const type = map.get("type");
    if (!from || !to || !RELATION_TYPES.includes(type as RelationType)) continue;
    if (tasks && (!tasks.has(from) || !tasks.has(to))) continue;
    relations.push({ id, from, to, type: type as RelationType });
  }
  return relations;
}

/** The column a task shows in: its own, or the first if that's gone. */
export function columnOf(task: Task, columns: Column[]): Column | undefined {
  return columns.find((c) => c.id === task.column) ?? columns[0];
}

/** A column's tasks, in order. */
export function tasksIn(columnId: string, columns: Column[], tasks: Iterable<Task>): Task[] {
  return [...tasks].filter((t) => columnOf(t, columns)?.id === columnId).sort(byRank);
}

/** How a link reads from one task's side: "blocks WEB-3", or the other way round, "is blocked by WEB-1". */
export const RELATION_LABELS: Record<RelationType, { out: string; in: string }> = {
  blocks: { out: "blocks", in: "is blocked by" },
  relates: { out: "relates to", in: "relates to" },
  duplicates: { out: "duplicates", in: "is duplicated by" },
  clones: { out: "clones", in: "is cloned by" },
};

export interface TaskLink {
  relation: Relation;
  label: string;
  other: Task;
  /** This task is the one blocked. */
  blockedBy: boolean;
}

/** A task's links to other tasks, from its side. */
export function linksOf(taskId: string, relations: Relation[], tasks: Map<string, Task>): TaskLink[] {
  const links: TaskLink[] = [];
  for (const r of relations) {
    const outgoing = r.from === taskId;
    if (!outgoing && r.to !== taskId) continue;
    const other = tasks.get(outgoing ? r.to : r.from);
    if (!other) continue;
    links.push({
      relation: r,
      label: outgoing ? RELATION_LABELS[r.type].out : RELATION_LABELS[r.type].in,
      other,
      blockedBy: !outgoing && r.type === "blocks",
    });
  }
  return links;
}

/** Whether a task waits on another that isn't done. */
export function isBlocked(taskId: string, relations: Relation[], tasks: Map<string, Task>, columns: Column[]): boolean {
  return relations.some((r) => {
    if (r.type !== "blocks" || r.to !== taskId) return false;
    const blocker = tasks.get(r.from);
    return !!blocker && columnOf(blocker, columns)?.category !== "done";
  });
}

/** A task's sub-tasks, in board order. */
export function subtasksOf(taskId: string, tasks: Map<string, Task>, columns: Column[]): Task[] {
  const order = new Map(columns.map((c, i) => [c.id, i]));
  return [...tasks.values()]
    .filter((t) => t.parent === taskId)
    .sort((a, b) => (order.get(a.column) ?? 99) - (order.get(b.column) ?? 99) || byRank(a, b));
}

/** Whether `ancestor` is `taskId` or above it: a task can't go under its own sub-tasks. */
export function isAncestor(ancestor: string, taskId: string, tasks: Map<string, Task>): boolean {
  for (let at: string | undefined = taskId, guard = 0; at && guard < 100; guard++) {
    if (at === ancestor) return true;
    at = tasks.get(at)?.parent;
  }
  return false;
}

/** A due date's state, against today (in this browser's time zone). */
export function dueState(
  due: string | undefined,
  done: boolean,
  today = localDate(),
): "none" | "overdue" | "today" | "soon" | "later" {
  if (!due || done) return "none";
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due <= addDays(today, 3) ? "soon" : "later";
}

/** yyyy-mm-dd for a date in this browser's time zone. */
export function localDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(day: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

/* ------------------------------------------------------------------ changing */

const now = () => new Date().toISOString();

/** Columns a kanban starts with. The server writes these when it's created; this is for one that somehow has none. */
export const DEFAULT_COLUMNS: { name: string; category: Category }[] = [
  { name: "To do", category: "todo" },
  { name: "In progress", category: "doing" },
  { name: "Done", category: "done" },
];

export function addColumn(doc: Y.Doc, name: string, category: Category = "doing", afterId?: string): string {
  const id = newId();
  doc.transact(() => {
    const columns = readColumns(doc);
    const at = afterId ? columns.findIndex((c) => c.id === afterId) : columns.length - 1;
    const map = new Y.Map<unknown>();
    map.set("name", name.trim() || "Column");
    map.set("category", category);
    map.set("rank", rankBetween(columns[at]?.rank ?? null, columns[at + 1]?.rank ?? null));
    columnsOf(doc).set(id, map);
  }, LOCAL);
  return id;
}

export function updateColumn(doc: Y.Doc, id: string, patch: Partial<Pick<Column, "name" | "category" | "wip">>): void {
  const map = columnsOf(doc).get(id);
  if (!map) return;
  doc.transact(() => {
    if (patch.name !== undefined) map.set("name", patch.name.trim() || "Column");
    if (patch.category !== undefined) map.set("category", patch.category);
    if ("wip" in patch) {
      if (patch.wip && patch.wip > 0) map.set("wip", Math.round(patch.wip));
      else map.delete("wip");
    }
  }, LOCAL);
}

/** Puts a column between two others (by id; null for the start or end). */
export function moveColumn(doc: Y.Doc, id: string, beforeId: string | null, afterId: string | null): void {
  const columns = readColumns(doc);
  const map = columnsOf(doc).get(id);
  if (!map) return;
  const rankOf = (cid: string | null) => (cid ? columns.find((c) => c.id === cid)?.rank : null) ?? null;
  doc.transact(() => map.set("rank", rankBetween(rankOf(beforeId), rankOf(afterId))), LOCAL);
}

/** Removes a column, moving its tasks to the bottom of `moveTo`. */
export function removeColumn(doc: Y.Doc, id: string, moveTo: string): void {
  if (id === moveTo) return;
  doc.transact(() => {
    const columns = readColumns(doc);
    const tasks = readTasks(doc);
    let rank = tasksIn(moveTo, columns, tasks.values()).at(-1)?.rank ?? null;
    for (const task of tasksIn(id, columns, tasks.values())) {
      rank = rankBetween(rank, null);
      const map = tasksOf(doc).get(task.id);
      map?.set("column", moveTo);
      map?.set("rank", rank);
    }
    columnsOf(doc).delete(id);
  }, LOCAL);
}

export interface NewTask {
  key: string;
  title: string;
  column: string;
  /** At the top of the column instead of the bottom. */
  top?: boolean;
  type?: TaskType;
  priority?: Priority;
  assignees?: string[];
  tags?: string[];
  due?: string;
  parent?: string;
  description?: string;
  docId?: string;
  createdBy?: string;
}

/** Adds a task to a column (its key comes from the server: see kanbanApi.reserveKeys). Returns its id. */
export function addTask(doc: Y.Doc, task: NewTask): string {
  const id = newId();
  doc.transact(() => {
    const columns = readColumns(doc);
    const siblings = tasksIn(task.column, columns, readTasks(doc).values());
    const rank = task.top
      ? rankBetween(null, siblings[0]?.rank ?? null)
      : rankBetween(siblings.at(-1)?.rank ?? null, null);
    const map = new Y.Map<unknown>();
    map.set("key", task.key);
    map.set("title", task.title.trim());
    map.set("description", new Y.Text(task.description ?? ""));
    map.set("column", task.column);
    map.set("rank", rank);
    map.set("type", task.type ?? "task");
    map.set("priority", task.priority ?? "medium");
    map.set("assignees", task.assignees ?? []);
    map.set("tags", task.tags ?? []);
    if (task.due) map.set("due", task.due);
    if (task.parent) map.set("parent", task.parent);
    if (task.docId) map.set("docId", task.docId);
    if (task.createdBy) {
      map.set("createdBy", task.createdBy);
      map.set("reporter", task.createdBy);
    }
    const at = now();
    map.set("createdAt", at);
    map.set("updatedAt", at);
    tasksOf(doc).set(id, map);
  }, LOCAL);
  return id;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | "title"
    | "type"
    | "priority"
    | "assignees"
    | "tags"
    | "reporter"
    | "due"
    | "start"
    | "estimate"
    | "parent"
    | "docId"
    | "extId"
    | "extKey"
    | "extUrl"
  >
>;

/** Changes a task's fields; `undefined` for an optional one removes it. */
export function updateTask(doc: Y.Doc, id: string, patch: TaskPatch): void {
  const map = tasksOf(doc).get(id);
  if (!map) return;
  doc.transact(() => {
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined || value === "") map.delete(field);
      else if (field === "title")
        map.set(field, String(value).replace(/\s+/g, " ").trim() || map.get("title") || "Untitled");
      else map.set(field, value);
    }
    map.set("updatedAt", now());
  }, LOCAL);
}

/** The task's description, made if it has none, to edit. */
export function descriptionOf(doc: Y.Doc, id: string): Y.Text | null {
  const map = tasksOf(doc).get(id);
  if (!map) return null;
  const text = map.get("description");
  if (text instanceof Y.Text) return text;
  const made = new Y.Text(typeof text === "string" ? text : "");
  doc.transact(() => map.set("description", made), LOCAL);
  return made;
}

/** Moves a task into a column, between two of its tasks (by id; null for the top or bottom). */
export function moveTask(
  doc: Y.Doc,
  id: string,
  column: string,
  beforeId: string | null,
  afterId: string | null,
): void {
  const map = tasksOf(doc).get(id);
  if (!map) return;
  const tasks = readTasks(doc);
  const rank = rankBetween(
    beforeId ? (tasks.get(beforeId)?.rank ?? null) : null,
    afterId ? (tasks.get(afterId)?.rank ?? null) : null,
  );
  doc.transact(() => {
    if (map.get("column") !== column) map.set("column", column);
    map.set("rank", rank);
    map.set("updatedAt", now());
  }, LOCAL);
}

/** Removes tasks, their links, and makes their sub-tasks stand on their own. */
export function removeTasks(doc: Y.Doc, ids: string[]): void {
  const gone = new Set(ids);
  doc.transact(() => {
    for (const id of gone) tasksOf(doc).delete(id);
    for (const [rid, map] of relationsOf(doc)) {
      if (gone.has(map.get("from") as string) || gone.has(map.get("to") as string)) relationsOf(doc).delete(rid);
    }
    for (const map of tasksOf(doc).values()) if (gone.has(map.get("parent") as string)) map.delete("parent");
  }, LOCAL);
}

/** Links two tasks. Linking the same two the same way again does nothing. */
export function addRelation(doc: Y.Doc, from: string, to: string, type: RelationType): string | null {
  if (from === to) return null;
  const existing = readRelations(doc).find(
    (r) =>
      r.type === type && ((r.from === from && r.to === to) || (type === "relates" && r.from === to && r.to === from)),
  );
  if (existing) return existing.id;
  const id = newId();
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("from", from);
    map.set("to", to);
    map.set("type", type);
    relationsOf(doc).set(id, map);
  }, LOCAL);
  return id;
}

export function removeRelation(doc: Y.Doc, id: string): void {
  doc.transact(() => relationsOf(doc).delete(id), LOCAL);
}

/* ------------------------------------------------------------------ the summary the server indexes */

export interface DocRef {
  id: string;
  folder: string;
  title: string;
}

/**
 * The markdown saved with the kanban, for search, #tags and backlinks: a heading per column, a line per task with its key,
 * title, #tags and due date, the doc it links as a [[link]], and its description indented below. The server writes the
 * same when it changes a kanban (KanbanDoc.Summary).
 */
function summaryLines(task: Task, docs: Map<string, DocRef>): string[] {
  let line = `- ${task.key} ${task.title.replace(/\s+/g, " ").trim()}`;
  for (const tag of task.tags) line += ` #${tag}`;
  if (task.due) line += ` (due ${task.due})`;
  const ref = task.docId ? docs.get(task.docId) : undefined;
  if (ref) line += ` [[${ref.folder ? `${ref.folder}/${ref.title}` : ref.title}]]`;
  const description = (task.description?.toString() ?? "").split("\n").filter((l) => l.trim());
  return [line, ...description.map((l) => `  ${l.trimEnd()}`)];
}

export function summaryMarkdown(doc: Y.Doc, docs: Map<string, DocRef>): string {
  const columns = readColumns(doc);
  const tasks = readTasks(doc);
  const out: string[] = [];
  for (const column of columns) {
    out.push(`## ${column.name}`, "");
    for (const task of tasksIn(column.id, columns, tasks.values())) out.push(...summaryLines(task, docs));
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** Makes the kanban what `source` is (a saved version), as one change: undo puts it back. */
export function replaceKanban(doc: Y.Doc, source: Y.Doc): void {
  const copy = (map: Y.Map<unknown>): Y.Map<unknown> => {
    const out = new Y.Map<unknown>();
    for (const [key, value] of map) {
      out.set(
        key,
        value instanceof Y.Text ? new Y.Text(value.toString()) : value instanceof Y.Map ? copy(value) : value,
      );
    }
    return out;
  };
  doc.transact(() => {
    for (const [target, from] of [
      [columnsOf(doc), columnsOf(source)],
      [tasksOf(doc), tasksOf(source)],
      [relationsOf(doc), relationsOf(source)],
    ] as const) {
      for (const id of [...target.keys()]) target.delete(id);
      for (const [id, map] of from) if (map instanceof Y.Map) target.set(id, copy(map));
    }
  }, LOCAL);
}

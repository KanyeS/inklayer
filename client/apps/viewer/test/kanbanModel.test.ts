import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addColumn,
  addRelation,
  addTask,
  columnsOf,
  DEFAULT_COLUMNS,
  dueState,
  isAncestor,
  isBlocked,
  LOCAL,
  linksOf,
  moveColumn,
  moveTask,
  readColumns,
  readRelations,
  readTasks,
  removeColumn,
  removeTasks,
  replaceKanban,
  subtasksOf,
  summaryMarkdown,
  tasksIn,
  updateColumn,
  updateTask,
} from "../src/kanban/kanbanModel";
import { byRank, rankBetween } from "../src/kanban/ranks";

/** Two copies of one kanban, kept in step like two browsers on the docs hub. */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && Y.applyUpdate(b, u, "remote"));
  b.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && Y.applyUpdate(a, u, "remote"));
  return { a, b };
}

/** A kanban with the default columns, as the server makes it. */
function kanban(doc = new Y.Doc()) {
  let rank: string | null = null;
  doc.transact(() => {
    for (const c of DEFAULT_COLUMNS) {
      rank = rankBetween(rank, null);
      const map = new Y.Map<unknown>();
      map.set("name", c.name);
      map.set("category", c.category);
      map.set("rank", rank);
      columnsOf(doc).set(c.name, map);
    }
  });
  return doc;
}

describe("ranks", () => {
  it("always fit another between two, before the first and after the last", () => {
    const ranks = [rankBetween(null, null)];
    for (let i = 0; i < 200; i++) {
      const at = i % (ranks.length + 1);
      ranks.splice(at, 0, rankBetween(ranks[at - 1] ?? null, ranks[at] ?? null));
    }
    expect([...ranks].sort()).toEqual(ranks);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ranks.every((r) => !r.endsWith("0"))).toBe(true);
    // Out of order (two people moved at once): goes after.
    expect(rankBetween("m", "c") > "m").toBe(true);
    const between = rankBetween("a", "b");
    expect(between > "a" && between < "b").toBe(true);
  });

  it("sorts ties by id, the same everywhere", () => {
    expect(
      [
        { rank: "m", id: "b" },
        { rank: "m", id: "a" },
        { rank: "c", id: "z" },
      ]
        .sort(byRank)
        .map((x) => x.id),
    ).toEqual(["z", "a", "b"]);
  });
});

describe("tasks", () => {
  it("are added to a column in order, and move between columns and around each other", () => {
    const { a, b } = pair();
    kanban(a);
    const [todo, doing] = readColumns(b);
    const one = addTask(a, { key: "WEB-1", title: " First ", column: todo!.id });
    const two = addTask(b, { key: "WEB-2", title: "Second", column: todo!.id });
    const top = addTask(a, { key: "WEB-3", title: "Urgent", column: todo!.id, top: true });
    expect(tasksIn(todo!.id, readColumns(b), readTasks(b).values()).map((t) => t.key)).toEqual([
      "WEB-3",
      "WEB-1",
      "WEB-2",
    ]);
    expect(readTasks(b).get(one)).toMatchObject({
      title: "First",
      type: "task",
      priority: "medium",
      assignees: [],
      tags: [],
    });

    moveTask(b, two, doing!.id, null, null);
    moveTask(a, top, todo!.id, one, null);
    expect(tasksIn(todo!.id, readColumns(a), readTasks(a).values()).map((t) => t.key)).toEqual(["WEB-1", "WEB-3"]);
    expect(tasksIn(doing!.id, readColumns(a), readTasks(a).values()).map((t) => t.key)).toEqual(["WEB-2"]);
  });

  it("merge when two people move cards at once", () => {
    const { a, b } = pair();
    kanban(a);
    const [todo] = readColumns(a);
    const ids = ["1", "2", "3"].map((n) => addTask(a, { key: `K-${n}`, title: n, column: todo!.id }));
    // Offline at the same time: both put a different card first.
    const offlineA = new Y.Doc();
    const offlineB = new Y.Doc();
    Y.applyUpdate(offlineA, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(offlineB, Y.encodeStateAsUpdate(b));
    moveTask(offlineA, ids[2]!, todo!.id, null, ids[0]!);
    moveTask(offlineB, ids[1]!, todo!.id, null, ids[0]!);
    Y.applyUpdate(offlineA, Y.encodeStateAsUpdate(offlineB));
    Y.applyUpdate(offlineB, Y.encodeStateAsUpdate(offlineA));
    const order = (d: Y.Doc) => tasksIn(todo!.id, readColumns(d), readTasks(d).values()).map((t) => t.title);
    expect(order(offlineA)).toEqual(order(offlineB));
    expect(order(offlineA).at(-1)).toBe("1");
  });

  it("change fields, and removing an optional one deletes it", () => {
    const doc = kanban();
    const id = addTask(doc, { key: "K-1", title: "Task", column: readColumns(doc)[0]!.id, due: "2026-12-01" });
    updateTask(doc, id, {
      assignees: ["u1", "u2"],
      tags: ["launch"],
      priority: "high",
      due: undefined,
      title: "  New   title ",
    });
    expect(readTasks(doc).get(id)).toMatchObject({
      assignees: ["u1", "u2"],
      tags: ["launch"],
      priority: "high",
      due: undefined,
      title: "New title",
    });
  });

  it("have sub-tasks and links; removing a task lets its sub-tasks stand alone and drops its links", () => {
    const doc = kanban();
    const [todo, , done] = readColumns(doc);
    const parent = addTask(doc, { key: "K-1", title: "Parent", column: todo!.id });
    const child = addTask(doc, { key: "K-2", title: "Child", column: done!.id, parent });
    const other = addTask(doc, { key: "K-3", title: "Other", column: todo!.id });
    addRelation(doc, other, parent, "blocks");
    expect(addRelation(doc, other, parent, "blocks")).toBe(readRelations(doc)[0]!.id); // the same link again: once
    const rel = addRelation(doc, parent, other, "relates");
    expect(addRelation(doc, other, parent, "relates")).toBe(rel); // relates goes both ways

    const tasks = readTasks(doc);
    const columns = readColumns(doc);
    const relations = readRelations(doc, tasks);
    expect(subtasksOf(parent, tasks, columns).map((t) => t.key)).toEqual(["K-2"]);
    expect(isBlocked(parent, relations, tasks, columns)).toBe(true);
    expect(linksOf(parent, relations, tasks).map((l) => `${l.label} ${l.other.key}`)).toEqual([
      "is blocked by K-3",
      "relates to K-3",
    ]);
    expect(isAncestor(parent, child, tasks)).toBe(true);
    expect(isAncestor(child, parent, tasks)).toBe(false);

    moveTask(doc, other, done!.id, null, null);
    expect(isBlocked(parent, readRelations(doc), readTasks(doc), columns)).toBe(false); // the blocker is done

    removeTasks(doc, [parent]);
    expect(readTasks(doc).get(child)?.parent).toBeUndefined();
    expect(readRelations(doc)).toEqual([]);
  });
});

describe("columns", () => {
  it("are added, renamed, reordered and removed, moving their tasks", () => {
    const doc = kanban();
    const [todo, doing, done] = readColumns(doc);
    const review = addColumn(doc, "Review", "doing", doing!.id);
    expect(readColumns(doc).map((c) => c.name)).toEqual(["To do", "In progress", "Review", "Done"]);
    updateColumn(doc, review, { name: "In review", wip: 3 });
    moveColumn(doc, review, todo!.id, doing!.id);
    expect(readColumns(doc).map((c) => `${c.name}${c.wip ? `/${c.wip}` : ""}`)).toEqual([
      "To do",
      "In review/3",
      "In progress",
      "Done",
    ]);

    addTask(doc, { key: "K-1", title: "Kept", column: review });
    addTask(doc, { key: "K-2", title: "Already done", column: done!.id });
    removeColumn(doc, review, done!.id);
    expect(readColumns(doc).map((c) => c.name)).toEqual(["To do", "In progress", "Done"]);
    expect(tasksIn(done!.id, readColumns(doc), readTasks(doc).values()).map((t) => t.key)).toEqual(["K-2", "K-1"]);
  });
});

describe("history and the summary", () => {
  it("restores a saved version as one undoable change", () => {
    const doc = kanban();
    const todo = readColumns(doc)[0]!.id;
    addTask(doc, { key: "K-1", title: "Old", column: todo, description: "Was here" });
    const saved = new Y.Doc();
    Y.applyUpdate(saved, Y.encodeStateAsUpdate(doc));
    const undo = new Y.UndoManager([columnsOf(doc), doc.getMap("tasks"), doc.getMap("relations")], {
      trackedOrigins: new Set([LOCAL]),
    });
    const added = addTask(doc, { key: "K-2", title: "New", column: todo });
    undo.stopCapturing();
    replaceKanban(doc, saved);
    expect([...readTasks(doc).values()].map((t) => [t.key, t.description?.toString()])).toEqual([["K-1", "Was here"]]);
    undo.undo();
    expect(readTasks(doc).has(added)).toBe(true);
  });

  it("lists tasks by column with tags, due dates, linked docs and descriptions", () => {
    const doc = kanban();
    const [todo, , done] = readColumns(doc);
    addTask(doc, {
      key: "WEB-1",
      title: "Launch",
      column: todo!.id,
      due: "2026-12-01",
      docId: "d1",
      description: "See [[Plan]]\n\n- step",
    });
    const t = addTask(doc, { key: "WEB-2", title: "Shipped", column: done!.id });
    updateTask(doc, t, { tags: ["release", "web"] });
    expect(summaryMarkdown(doc, new Map([["d1", { id: "d1", folder: "Plans", title: "Launch plan" }]]))).toBe(
      "## To do\n\n- WEB-1 Launch (due 2026-12-01) [[Plans/Launch plan]]\n  See [[Plan]]\n  - step\n\n## In progress\n\n\n## Done\n\n- WEB-2 Shipped #release #web\n",
    );
  });

  it("says whether a due date is past, today, soon or later", () => {
    expect(dueState("2026-11-27", false, "2026-11-28")).toBe("overdue");
    expect(dueState("2026-11-28", false, "2026-11-28")).toBe("today");
    expect(dueState("2026-11-30", false, "2026-11-28")).toBe("soon");
    expect(dueState("2026-12-30", false, "2026-11-28")).toBe("later");
    expect(dueState("2026-11-01", true, "2026-11-28")).toBe("none");
  });
});

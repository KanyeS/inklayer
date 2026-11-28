import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { KanbanColumns } from "../src/kanban/KanbanColumns";
import { KanbanContext, type KanbanContextValue, useKanbanState } from "../src/kanban/kanbanContext";
import { addRelation, addTask, columnsOf, DEFAULT_COLUMNS, readColumns, readTasks } from "../src/kanban/kanbanModel";
import { rankBetween } from "../src/kanban/ranks";
import { TaskPanel } from "../src/kanban/TaskPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function kanban() {
  const doc = new Y.Doc();
  let rank: string | null = null;
  for (const c of DEFAULT_COLUMNS) {
    rank = rankBetween(rank, null);
    const map = new Y.Map<unknown>();
    map.set("name", c.name);
    map.set("category", c.category);
    map.set("rank", rank);
    columnsOf(doc).set(c.name, map);
  }
  return doc;
}

type Child = (state: ReturnType<typeof useKanbanState>) => ReturnType<typeof createElement>;

function Host({ context, child }: { context: KanbanContextValue; child: Child }) {
  return createElement(KanbanContext.Provider, { value: context }, child(useKanbanState(context.doc)));
}

const queries = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });

function App(props: { context: KanbanContextValue; child: Child }) {
  return createElement(QueryClientProvider, { client: queries }, createElement(Host, props));
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function render(
  doc: Y.Doc,
  overrides: Partial<KanbanContextValue>,
  child: (state: ReturnType<typeof useKanbanState>) => ReturnType<typeof createElement>,
) {
  const context: KanbanContextValue = {
    orgId: "org",
    kanbanId: "k",
    doc,
    session: null,
    tree: { folders: [], docs: [], canEdit: true },
    canEdit: true,
    meId: "me",
    people: new Map([
      ["me", { id: "me", displayName: "Ana Silva", fullName: "Ana Silva" }],
      ["ben", { id: "ben", displayName: "Ben", fullName: "Ben Okafor" }],
    ]),
    openTask: () => undefined,
    createTask: async () => "",
    ...overrides,
  };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(App, { context, child })));
  return host;
}

describe("the kanban page", () => {
  it("shows each column's cards with their key, assignees, tags, sub-task progress and blockers", () => {
    const doc = kanban();
    const [todo, , done] = readColumns(doc);
    const parent = addTask(doc, {
      key: "WEB-1",
      title: "Launch the site",
      column: todo!.id,
      assignees: ["ben"],
      tags: ["launch"],
      due: "2020-01-01",
    });
    addTask(doc, { key: "WEB-2", title: "Write copy", column: done!.id, parent });
    const blocker = addTask(doc, { key: "WEB-3", title: "Buy domain", column: todo!.id });
    addRelation(doc, blocker, parent, "blocks");
    const openTask = vi.fn();
    const host = render(doc, { openTask }, (state) =>
      createElement(KanbanColumns, { state, visible: () => true, groupBy: "none", selected: null, peers: [] }),
    );

    const headers = [...host.querySelectorAll(".kanban-column-name")].map((h) => h.textContent);
    expect(headers).toEqual(["To do", "In progress", "Done"]);
    const card = host.querySelector<HTMLElement>(`[data-task-id="${parent}"]`)!;
    expect(card.textContent).toContain("Launch the site");
    expect(card.textContent).toContain("WEB-1");
    expect(card.textContent).toContain("launch");
    expect(card.textContent).toContain("1/1");
    expect(card.querySelector(".kanban-blocked")).not.toBeNull();
    expect(card.querySelector(".kanban-due-overdue")).not.toBeNull();
    expect(card.querySelector(".kanban-avatar")?.textContent).toBe("B");

    act(() => card.click());
    expect(openTask).toHaveBeenCalledWith(parent);
  });

  it("groups cards into swimlanes by assignee", () => {
    const doc = kanban();
    const todo = readColumns(doc)[0]!.id;
    addTask(doc, { key: "K-1", title: "Ben's", column: todo, assignees: ["ben"] });
    addTask(doc, { key: "K-2", title: "Nobody's", column: todo });
    const host = render(doc, {}, (state) =>
      createElement(KanbanColumns, { state, visible: () => true, groupBy: "assignee", selected: null, peers: [] }),
    );
    expect([...host.querySelectorAll(".kanban-lane-title")].map((l) => l.firstChild?.textContent)).toEqual([
      "Ben",
      "Unassigned",
    ]);
  });

  it("opens a task in the panel, where its fields change it live", () => {
    const doc = kanban();
    const [todo, doing] = readColumns(doc);
    const id = addTask(doc, { key: "WEB-7", title: "Fix login", column: todo!.id, description: "Steps" });
    const child = addTask(doc, { key: "WEB-8", title: "Reproduce", column: todo!.id, parent: id });
    const host = render(doc, {}, (state) => {
      const task = state.tasks.get(id)!;
      return createElement(TaskPanel, { task, state, onClose: () => undefined });
    });
    expect(host.textContent).toContain("WEB-7");
    expect(host.querySelector<HTMLTextAreaElement>(".kanban-panel-title")?.value).toBe("Fix login");
    expect(host.textContent).toContain("Reproduce");

    const status = host.querySelector<HTMLSelectElement>('select[aria-label="Status"]')!;
    act(() => {
      status.value = doing!.id;
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(readTasks(doc).get(id)?.column).toBe(doing!.id);

    // Ticking a sub-task moves it to the done column.
    const tick = host.querySelector<HTMLInputElement>('input[aria-label="WEB-8 done"]')!;
    act(() => tick.click());
    expect(readColumns(doc).find((c) => c.id === readTasks(doc).get(child)?.column)?.category).toBe("done");
  });
});

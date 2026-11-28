import type { KanbanSettingsResponse, PersonResponse, TaskSummaryResponse } from "@inklayer/api";
import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type KanbanSettings = KanbanSettingsResponse;
export type KanbanPerson = PersonResponse;
export type TaskSummary = TaskSummaryResponse;

const kanban = (kanbanId: string) => ({ params: { path: { kanbanId } } });

export const kanbanApi = {
  /** Keys for new tasks, given to no one else: `${prefix}-${first}` onwards. */
  reserveKeys: async (kanbanId: string, count = 1): Promise<string[]> => {
    const r = await api.post("/api/kanbans/{kanbanId}/keys", { ...kanban(kanbanId), body: { count } });
    return Array.from({ length: r.count }, (_, i) => `${r.prefix}-${r.first + i}`);
  },
  settings: (kanbanId: string) => api.get("/api/kanbans/{kanbanId}/settings", kanban(kanbanId)),
  updateSettings: (kanbanId: string, body: { keyPrefix?: string }) =>
    api.put("/api/kanbans/{kanbanId}/settings", { ...kanban(kanbanId), body: { keyPrefix: body.keyPrefix ?? null } }),
  people: (kanbanId: string) => api.get("/api/kanbans/{kanbanId}/people", kanban(kanbanId)),
  boardTasks: (kanbanId: string) => api.get("/api/kanbans/{kanbanId}/tasks", kanban(kanbanId)),
  tasks: (
    orgId: string,
    query: {
      assignee?: string;
      status?: "open" | "done" | "all";
      tag?: string;
      due?: "overdue" | "week";
      q?: string;
    } = {},
  ) => api.get("/api/orgs/{orgId}/tasks", { params: { path: { orgId }, query } }),
  trackerChoices: (kanbanId: string) => api.get("/api/kanbans/{kanbanId}/tracker/choices", kanban(kanbanId)),
  trackerStatuses: (kanbanId: string, connectionId: string) =>
    api.get("/api/kanbans/{kanbanId}/tracker/statuses", { params: { path: { kanbanId }, query: { connectionId } } }),
  connectTracker: (
    kanbanId: string,
    body: {
      connectionId: string;
      direction: "both" | "from-tracker";
      statusMap: Record<string, string>;
      addColumns: boolean;
      pushExisting: boolean;
    },
  ) => api.put("/api/kanbans/{kanbanId}/tracker", { ...kanban(kanbanId), body }),
  disconnectTracker: (kanbanId: string) => api.delete("/api/kanbans/{kanbanId}/tracker", kanban(kanbanId)),
  syncNow: (kanbanId: string) => api.post("/api/kanbans/{kanbanId}/tracker/sync", kanban(kanbanId)),
  mentions: (kanbanId: string, key: string) =>
    api.get("/api/kanbans/{kanbanId}/mentions", { params: { path: { kanbanId }, query: { key } } }),
  taskByKey: (orgId: string, key: string) =>
    api.get("/api/orgs/{orgId}/tasks/{key}", { params: { path: { orgId, key } } }),
};

export const kanbanQueries = {
  settings: (kanbanId: string) =>
    queryOptions({ queryKey: ["kanbans", kanbanId, "settings"], queryFn: () => kanbanApi.settings(kanbanId) }),
  /** Everyone tasks can be given to; rarely changes. */
  people: (kanbanId: string) =>
    queryOptions({
      queryKey: ["kanbans", kanbanId, "people"],
      queryFn: () => kanbanApi.people(kanbanId),
      staleTime: 5 * 60_000,
    }),
  /** A kanban's tasks as the server last saved them (a few seconds behind), for task cards on canvas boards. */
  boardTasks: (kanbanId: string) =>
    queryOptions({
      queryKey: ["kanbans", kanbanId, "tasks"],
      queryFn: () => kanbanApi.boardTasks(kanbanId),
      refetchInterval: 15_000,
    }),
  myTasks: (orgId: string) =>
    queryOptions({
      queryKey: ["orgs", orgId, "tasks", "mine"],
      queryFn: () => kanbanApi.tasks(orgId, { assignee: "me", status: "open" }),
      refetchInterval: 60_000,
    }),
  /** Docs that link a task with [[task:KEY]]. */
  trackerChoices: (kanbanId: string) => api.get("/api/kanbans/{kanbanId}/tracker/choices", kanban(kanbanId)),
  trackerStatuses: (kanbanId: string, connectionId: string) =>
    api.get("/api/kanbans/{kanbanId}/tracker/statuses", { params: { path: { kanbanId }, query: { connectionId } } }),
  connectTracker: (
    kanbanId: string,
    body: {
      connectionId: string;
      direction: "both" | "from-tracker";
      statusMap: Record<string, string>;
      addColumns: boolean;
      pushExisting: boolean;
    },
  ) => api.put("/api/kanbans/{kanbanId}/tracker", { ...kanban(kanbanId), body }),
  disconnectTracker: (kanbanId: string) => api.delete("/api/kanbans/{kanbanId}/tracker", kanban(kanbanId)),
  syncNow: (kanbanId: string) => api.post("/api/kanbans/{kanbanId}/tracker/sync", kanban(kanbanId)),
  mentions: (kanbanId: string, key: string) =>
    queryOptions({
      queryKey: ["kanbans", kanbanId, "mentions", key],
      queryFn: () => kanbanApi.mentions(kanbanId, key),
      refetchInterval: 30_000,
    }),
  /** A task by key, for [[task:WEB-12]] in docs. Null if there's none this person can see. */
  task: (orgId: string, key: string) =>
    queryOptions({
      queryKey: ["orgs", orgId, "tasks", "key", key.toUpperCase()],
      queryFn: () => kanbanApi.taskByKey(orgId, key).catch(() => null),
      staleTime: 30_000,
    }),
};

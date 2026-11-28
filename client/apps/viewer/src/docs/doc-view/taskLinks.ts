import type { EditorHooks } from "@inklayer/docs/editor";
import { kanbanApi, type TaskSummary } from "@/kanban/kanbanApi";
import { navigate } from "@/lib/router";
import { docPath } from "../docsApi";

/**
 * [[task:WEB-12]] in docs: the task, looked up by key in the reader's organisation (once a minute at most), shown as a
 * chip in the editor and a line with its status in reading view, and opened on its kanban.
 */

const FRESH_MS = 60_000;
const cache = new Map<string, { at: number; task: Promise<TaskSummary | null> }>();

export function loadTask(orgId: string, key: string): Promise<TaskSummary | null> {
  const id = `${orgId}/${key.toUpperCase()}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.task;
  const task = kanbanApi.taskByKey(orgId, key).catch(() => null);
  cache.set(id, { at: Date.now(), task });
  return task;
}

/** The task's page: its kanban, with the task open. */
export function taskHref(task: Pick<TaskSummary, "organizationId" | "kanbanId" | "key">): string {
  return `${docPath(task.organizationId, task.kanbanId)}?task=${encodeURIComponent(task.key)}`;
}

export async function openTask(orgId: string, key: string, newTab: boolean): Promise<void> {
  const task = await loadTask(orgId, key);
  if (!task) return;
  if (newTab) window.open(taskHref(task), "_blank", "noopener");
  else navigate(taskHref(task));
}

/** What a chip says after the key: the title, and the status once it's done. */
export function taskChipLabel(task: TaskSummary | null): string {
  if (!task) return "(not found)";
  return task.category === "done" ? `${task.title} ✓` : `${task.title} · ${task.column}`;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

/** Fills a reading-view task link with the task's key, title, status and who has it. Built with textContent, never parsed. */
export function fillTaskLink(el: HTMLAnchorElement, task: TaskSummary | null, key: string): void {
  el.replaceChildren(span("doc-task-key", key));
  if (!task) {
    el.classList.add("doc-task-missing");
    el.append(span("doc-task-title", "A task you can't see, or that's gone"));
    el.removeAttribute("href");
    return;
  }
  el.href = taskHref(task);
  el.classList.toggle("doc-task-done", task.category === "done");
  el.append(span("doc-task-title", task.title), span("doc-task-status", task.column));
  const who = task.assignees.map((a) => a.displayName).join(", ");
  el.title = [task.kanbanTitle, who && `Assigned to ${who}`, task.due && `Due ${task.due}`].filter(Boolean).join(" · ");
}

/** The editor's hooks for task links: labels (refreshing the chips once they load), opening, and suggestions. */
export function taskHooks(orgId: string, refresh: () => void): Pick<EditorHooks, "taskLabel" | "openTask" | "tasks"> {
  const labels = new Map<string, string>();
  return {
    taskLabel: (key) => {
      const label = labels.get(key);
      if (label === undefined) {
        labels.set(key, "");
        void loadTask(orgId, key).then((t) => {
          labels.set(key, taskChipLabel(t));
          refresh();
        });
      }
      return label || undefined;
    },
    openTask: (key, newTab) => void openTask(orgId, key, newTab),
    tasks: async (query) => {
      const found = await kanbanApi.tasks(orgId, { status: "all", ...(query ? { q: query } : {}) });
      return found.slice(0, 20).map((t) => ({ key: t.key, title: t.title, detail: `${t.kanbanTitle} · ${t.column}` }));
    },
  };
}

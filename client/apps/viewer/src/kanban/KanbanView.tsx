import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { cn } from "@inklayer/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Building2, History, Search, Settings, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMe } from "@/App";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorText, Loading } from "@/components/Layout";
import { DocSession } from "@/docs/collab";
import { PeopleHere, SaveStatus, TitleRow } from "@/docs/doc-view/DocHeader";
import { OrgShareButton } from "@/docs/doc-view/OrgShareDialog";
import { useSessionState } from "@/docs/doc-view/useSessionState";
import { type DocTree, docsApi } from "@/docs/docsApi";
import { queries } from "@/lib/queries";
import { navigate } from "@/lib/router";
import { type GroupBy, KanbanColumns } from "./KanbanColumns";
import { KanbanHistory } from "./KanbanHistory";
import { KanbanSettingsDialog } from "./KanbanSettings";
import { kanbanApi, kanbanQueries } from "./kanbanApi";
import { KanbanContext, type KanbanContextValue, useKanbanPeers, useKanbanState } from "./kanbanContext";
import { addTask, PRIORITIES, summaryMarkdown, TASK_TYPES, type Task } from "./kanbanModel";
import { Avatar } from "./pickers";
import { PRIORITY_LABELS, TYPE_LABELS } from "./TaskCard";
import { TaskPanel } from "./TaskPanel";

/** Links and backlinks are worked out by the server from saved summaries: refresh the details this often. */
const INFO_REFRESH_MS = 15_000;

interface Filters {
  text: string;
  assignees: string[];
  mine: boolean;
  tag: string;
  type: string;
  priority: string;
  hideSubtasks: boolean;
}

const NO_FILTERS: Filters = {
  text: "",
  assignees: [],
  mine: false,
  tag: "",
  type: "",
  priority: "",
  hideSubtasks: false,
};

/** The ?task=KEY in the address: the task that's open. */
function taskInUrl(): string | null {
  return new URLSearchParams(window.location.search).get("task");
}

function setTaskInUrl(key: string | null): void {
  const url = new URL(window.location.href);
  if (key) url.searchParams.set("task", key);
  else url.searchParams.delete("task");
  window.history.replaceState(null, "", url);
}

/**
 * A kanban: Jira-style columns of tasks, co-edited live like a doc (the same hub, access, sharing and history). Its
 * summary, saved with each snapshot, lists its tasks with their #tags and linked docs, so search and backlinks find it.
 */
export function KanbanView({ orgId, docId, tree }: { orgId: string; docId: string; tree: DocTree }) {
  const info = useQuery({ ...queries.doc(docId), refetchInterval: INFO_REFRESH_MS });
  const people = useQuery(kanbanQueries.people(docId));
  const { me } = useMe();
  const liveCursors = me.features.liveCursors;
  const treeRef = useRef(tree);
  treeRef.current = tree;

  const [session, setSession] = useState<DocSession | null>(null);
  useEffect(() => {
    const s = new DocSession(docId);
    s.shareAwareness = liveCursors;
    s.markdown = () => summaryMarkdown(s.doc, new Map(treeRef.current.docs.map((d) => [d.id, d])));
    setSession(s);
    void s.open();
    return () => {
      void s.close();
    };
  }, [docId, liveCursors]);

  const sessionState = useSessionState(session);
  const canEdit = sessionState?.canEdit ?? false;
  const [error, setError] = useState<Error | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (info.error)
    return (
      <div className="p-6 xl:col-span-2">
        <ErrorText error={info.error} />
      </div>
    );
  if (!info.data || !session)
    return (
      <div className="p-6 xl:col-span-2">
        <Loading />
      </div>
    );

  const remove = async () => {
    try {
      await docsApi.delete(info.data.id, info.data.version);
      navigate(`/orgs/${orgId}/docs`);
    } catch (e) {
      setError(e as Error);
    }
  };

  return (
    <main className="board-page kanban-page">
      <header className="board-header">
        <div className="min-w-0 flex-1 [&_.doc-title-input]:text-xl [&>div]:mt-0">
          <TitleRow info={info.data} canEdit={canEdit && !!info.data.canManage} onError={setError} />
        </div>
        {info.data.sharedFrom && (
          <Badge
            variant="outline"
            title={`This kanban belongs to ${info.data.sharedFrom.name}, which shares it with this organisation.`}
          >
            <Building2 data-icon="inline-start" />
            Shared from {info.data.sharedFrom.name}
          </Badge>
        )}
        <SaveStatus status={sessionState?.status ?? "connecting"} canEdit={canEdit} />
        <PeopleHere peers={sessionState?.peers ?? []} />
        <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
          <History data-icon="inline-start" />
          History
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
          <Settings data-icon="inline-start" />
          Settings
        </Button>
        <OrgShareButton info={info.data} />
        {info.data.canManage && (
          <ConfirmButton
            title={`Delete "${info.data.title}"?`}
            description="Anyone with it open loses it, with all its tasks. Docs its tasks link stay where they are. You can restore the kanban from Deleted docs at the bottom of the sidebar."
            confirmLabel="Delete kanban"
            onConfirm={() => void remove()}
          >
            <Trash2 />
          </ConfirmButton>
        )}
      </header>
      <ErrorText error={error} />
      {sessionState?.loaded ? (
        <KanbanBody
          orgId={orgId}
          kanbanId={docId}
          session={session}
          tree={tree}
          canEdit={canEdit}
          meId={me.id}
          people={people.data ?? []}
          historyOpen={historyOpen}
          onHistoryOpenChange={setHistoryOpen}
        />
      ) : sessionState?.status === "offline" || sessionState?.status === "closed" ? (
        <div className="p-6">
          <ErrorText error={new Error(sessionState.error || "Can't reach the server. Retrying…")} />
        </div>
      ) : (
        <div className="p-6">
          <Loading />
        </div>
      )}
      <KanbanSettingsDialog kanbanId={docId} doc={session.doc} open={settingsOpen} onOpenChange={setSettingsOpen} />
    </main>
  );
}

function KanbanBody({
  orgId,
  kanbanId,
  session,
  tree,
  canEdit,
  meId,
  people,
  historyOpen,
  onHistoryOpenChange,
}: {
  orgId: string;
  kanbanId: string;
  session: DocSession;
  tree: DocTree;
  canEdit: boolean;
  meId: string;
  people: { id: string; displayName: string; fullName: string }[];
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
}) {
  const state = useKanbanState(session.doc);
  const peers = useKanbanPeers(session);
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const search = useRef<HTMLInputElement>(null);

  // The open task, kept in the address as ?task=KEY so it can be linked to.
  const [openKey, setOpenKey] = useState<string | null>(taskInUrl);
  // A link to another task on this kanban (from a notification, say) changes the address without leaving the page.
  useEffect(() => {
    const onNavigate = () => setOpenKey(taskInUrl());
    window.addEventListener("popstate", onNavigate);
    window.addEventListener("inklayer:navigate", onNavigate);
    return () => {
      window.removeEventListener("popstate", onNavigate);
      window.removeEventListener("inklayer:navigate", onNavigate);
    };
  }, []);
  const selected = useMemo(() => {
    if (!openKey) return null;
    const wanted = openKey.toUpperCase();
    return [...state.tasks.values()].find((t) => t.key.toUpperCase() === wanted || t.id === openKey) ?? null;
  }, [openKey, state.tasks]);
  const openTask = useCallback(
    (taskId: string | null) => {
      const task = taskId ? state.tasks.get(taskId) : null;
      const key = task?.key || task?.id || null;
      setOpenKey(key);
      setTaskInUrl(key);
    },
    [state.tasks],
  );

  const createTask = useCallback<KanbanContextValue["createTask"]>(
    async ({ title, column, parent, top, assignees }) => {
      const [key] = await kanbanApi.reserveKeys(kanbanId, 1);
      if (!key) throw new Error("The server didn't give the task a key. Try again.");
      return addTask(session.doc, { key, title, column, parent, top, assignees, createdBy: meId });
    },
    [kanbanId, session.doc, meId],
  );

  const context = useMemo<KanbanContextValue>(
    () => ({
      orgId,
      kanbanId,
      doc: session.doc,
      session,
      tree,
      canEdit,
      meId,
      people: peopleById,
      openTask,
      createTask,
    }),
    [orgId, kanbanId, session, tree, canEdit, meId, peopleById, openTask, createTask],
  );

  // Keys: C creates a task (in the first column), / searches, Esc closes the open task.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest("input,textarea,select,[contenteditable=true],.cm-editor") ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      if (e.key === "c" && canEdit) {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>("[data-quick-add]")?.click();
      } else if (e.key === "/") {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === "Escape" && openKey) {
        openTask(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, openKey, openTask]);

  const visible = useCallback(
    (task: Task) => {
      const f = filters;
      if (f.hideSubtasks && task.parent) return false;
      if (f.mine && !task.assignees.includes(meId)) return false;
      if (
        f.assignees.length &&
        !f.assignees.some((a) => (a === "" ? task.assignees.length === 0 : task.assignees.includes(a)))
      )
        return false;
      if (f.tag && !task.tags.includes(f.tag)) return false;
      if (f.type && task.type !== f.type) return false;
      if (f.priority && task.priority !== f.priority) return false;
      if (f.text) {
        const q = f.text.toLowerCase();
        if (!`${task.key} ${task.title} ${task.description?.toString() ?? ""}`.toLowerCase().includes(q)) return false;
      }
      return true;
    },
    [filters, meId],
  );

  const assigneesInUse = useMemo(() => {
    const ids = new Set<string>();
    for (const t of state.tasks.values()) for (const a of t.assignees) ids.add(a);
    return [...ids].sort((a, b) =>
      (peopleById.get(a)?.displayName ?? "~").localeCompare(peopleById.get(b)?.displayName ?? "~"),
    );
  }, [state.tasks, peopleById]);
  const tagsInUse = useMemo(() => [...new Set([...state.tasks.values()].flatMap((t) => t.tags))].sort(), [state.tasks]);
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
  const toggleAssignee = (id: string) =>
    setFilters((f) => ({
      ...f,
      assignees: f.assignees.includes(id) ? f.assignees.filter((a) => a !== id) : [...f.assignees, id],
    }));

  return (
    <KanbanContext.Provider value={context}>
      <div className="kanban-toolbar">
        <label className="kanban-search">
          <Search className="size-4 text-muted-foreground" />
          <input
            ref={search}
            placeholder="Search tasks"
            aria-label="Search tasks"
            value={filters.text}
            onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))}
          />
        </label>
        <fieldset className="kanban-filter-people" aria-label="Only tasks assigned to">
          {assigneesInUse.slice(0, 8).map((id) => (
            <button
              key={id}
              type="button"
              className={cn("kanban-filter-avatar", filters.assignees.includes(id) && "kanban-filter-avatar-on")}
              aria-pressed={filters.assignees.includes(id)}
              onClick={() => toggleAssignee(id)}
            >
              <Avatar id={id} person={peopleById.get(id)} size={28} />
            </button>
          ))}
        </fieldset>
        <Button
          variant={filters.mine ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={filters.mine}
          onClick={() => setFilters((f) => ({ ...f, mine: !f.mine }))}
        >
          Only my tasks
        </Button>
        <NativeSelect
          size="sm"
          aria-label="Tag"
          value={filters.tag}
          onChange={(e) => setFilters((f) => ({ ...f, tag: e.target.value }))}
        >
          <NativeSelectOption value="">Any tag</NativeSelectOption>
          {tagsInUse.map((t) => (
            <NativeSelectOption key={t} value={t}>
              #{t}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          size="sm"
          aria-label="Type"
          value={filters.type}
          onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
        >
          <NativeSelectOption value="">Any type</NativeSelectOption>
          {TASK_TYPES.map((t) => (
            <NativeSelectOption key={t} value={t}>
              {TYPE_LABELS[t]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          size="sm"
          aria-label="Priority"
          value={filters.priority}
          onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}
        >
          <NativeSelectOption value="">Any priority</NativeSelectOption>
          {PRIORITIES.map((p) => (
            <NativeSelectOption key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={filters.hideSubtasks}
            onChange={(e) => setFilters((f) => ({ ...f, hideSubtasks: e.target.checked }))}
          />
          Hide sub-tasks
        </label>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
            <X data-icon="inline-start" /> Clear filters
          </Button>
        )}
        <span className="flex-1" />
        <label htmlFor="kanban-group-by" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          Group by
          <NativeSelect
            id="kanban-group-by"
            size="sm"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          >
            <NativeSelectOption value="none">Nothing</NativeSelectOption>
            <NativeSelectOption value="assignee">Assignee</NativeSelectOption>
            <NativeSelectOption value="epic">Epic</NativeSelectOption>
          </NativeSelect>
        </label>
      </div>
      <div className={cn("kanban-main", selected && "kanban-main-with-panel")}>
        <KanbanColumns
          state={state}
          visible={visible}
          groupBy={groupBy}
          selected={selected?.id ?? null}
          peers={peers}
        />
        {selected && <TaskPanel key={selected.id} task={selected} state={state} onClose={() => openTask(null)} />}
      </div>
      <KanbanHistory open={historyOpen} onOpenChange={onHistoryOpenChange} />
    </KanbanContext.Provider>
  );
}

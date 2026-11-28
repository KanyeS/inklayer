import { createEditor, type DocEditor, type EditorHooks } from "@inklayer/docs/editor";
import { Button } from "@inklayer/ui/components/button";
import { DatePicker } from "@inklayer/ui/components/date-picker";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@inklayer/ui/components/popover";
import { cn } from "@inklayer/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, FileText, Link2, ListTree, Pin, Plus, Tag, Trash2, Unlink, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { DocSession, editDoc } from "@/docs/collab";
import { taskHooks } from "@/docs/doc-view/taskLinks";
import { type DocSummary, docPath, docsApi } from "@/docs/docsApi";
import { pathOf, resolveLink } from "@/docs/links";
import { lookupPeople } from "@/lib/api";
import { navigate } from "@/lib/router";
import { CATEGORY_LABELS } from "./KanbanColumns";
import { kanbanQueries } from "./kanbanApi";
import { type KanbanState, useKanbanContext } from "./kanbanContext";
import {
  addRelation,
  columnOf,
  descriptionOf,
  dueState,
  isAncestor,
  linksOf,
  moveTask,
  PRIORITIES,
  RELATION_LABELS,
  RELATION_TYPES,
  type RelationType,
  removeRelation,
  removeTasks,
  subtasksOf,
  TASK_TYPES,
  type Task,
  tasksIn,
  updateTask,
} from "./kanbanModel";
import { PeoplePicker, PickerList, TagPicker, TaskPicker } from "./pickers";
import { PRIORITY_LABELS, PriorityIcon, TYPE_LABELS, TypeIcon } from "./TaskCard";

/** The task's details beside the board: everything about it, editable live. */
export function TaskPanel({ task, state, onClose }: { task: Task; state: KanbanState; onClose: () => void }) {
  const { doc, canEdit, people, meId, orgId, kanbanId, tree, openTask, createTask, pinTask } = useKanbanContext();
  const { columns, tasks, relations } = state;
  const column = columnOf(task, columns);
  const done = column?.category === "done";
  const knownTags = useMemo(() => (tree.tags ?? []).map((t) => t.tag), [tree.tags]);
  const [error, setError] = useState("");

  const set = (patch: Parameters<typeof updateTask>[2]) => updateTask(doc, task.id, patch);
  const subtasks = subtasksOf(task.id, tasks, columns);
  const links = linksOf(task.id, relations, tasks);
  const parent = task.parent ? tasks.get(task.parent) : undefined;
  const others = [...tasks.values()].filter((t) => t.id !== task.id);

  const moveTo = (columnId: string) => {
    const last = tasksIn(columnId, columns, tasks.values())
      .filter((t) => t.id !== task.id)
      .at(-1);
    moveTask(doc, task.id, columnId, last?.id ?? null, null);
  };

  const copyLink = () => {
    const url = `${window.location.origin}${docPath(orgId, kanbanId)}?task=${encodeURIComponent(task.key)}`;
    void navigator.clipboard?.writeText(url);
  };

  const remove = () => {
    const extra = subtasks.length
      ? ` Its ${subtasks.length} sub-task${subtasks.length === 1 ? "" : "s"} stay, on their own.`
      : "";
    if (!window.confirm(`Delete ${task.key} "${task.title}"?${extra} You can bring it back from the kanban's history.`))
      return;
    removeTasks(doc, [task.id]);
    onClose();
  };

  return (
    <aside className="kanban-panel" aria-label={`${task.key} ${task.title}`}>
      <header className="kanban-panel-head">
        <NativeSelect
          size="sm"
          aria-label="Type"
          disabled={!canEdit}
          value={task.type}
          onChange={(e) => set({ type: e.target.value as Task["type"] })}
          className="w-28"
        >
          {TASK_TYPES.map((t) => (
            <NativeSelectOption key={t} value={t}>
              {TYPE_LABELS[t]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <TypeIcon type={task.type} />
        <span className="font-mono text-sm text-muted-foreground">{task.key}</span>
        {task.extKey && (
          <a href={task.extUrl} target="_blank" rel="noreferrer" className="kanban-ext" title="Open in Jira">
            <ExternalLink className="size-3" /> {task.extKey}
          </a>
        )}
        <span className="flex-1" />
        {pinTask && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Put it on the board as a card of its own"
            onClick={() => pinTask(task)}
          >
            <Pin />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" title="Copy a link to this task" onClick={copyLink}>
          <Copy />
        </Button>
        {canEdit && (
          <Button variant="ghost" size="icon-sm" title="Delete task" onClick={remove}>
            <Trash2 />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" title="Close (Esc)" onClick={onClose}>
          <X />
        </Button>
      </header>

      <div className="kanban-panel-body">
        {parent && (
          <button type="button" className="kanban-panel-parent" onClick={() => openTask(parent.id)}>
            <ListTree className="size-3.5" /> {parent.key} {parent.title}
          </button>
        )}
        <TitleInput key={task.id} task={task} canEdit={canEdit} onSave={(title) => set({ title })} />

        <dl className="kanban-fields">
          <dt>Status</dt>
          <dd>
            <NativeSelect
              size="sm"
              aria-label="Status"
              disabled={!canEdit}
              value={column?.id ?? ""}
              onChange={(e) => moveTo(e.target.value)}
            >
              {columns.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {column && <span className="ml-2 text-xs text-muted-foreground">{CATEGORY_LABELS[column.category]}</span>}
          </dd>

          <dt>Assignees</dt>
          <dd>
            <PeoplePicker
              value={task.assignees}
              onChange={(assignees) => set({ assignees })}
              people={people}
              meId={meId}
              disabled={!canEdit}
            />
          </dd>

          <dt>Priority</dt>
          <dd className="flex items-center gap-2">
            <PriorityIcon priority={task.priority} />
            <NativeSelect
              size="sm"
              aria-label="Priority"
              disabled={!canEdit}
              value={task.priority}
              onChange={(e) => set({ priority: e.target.value as Task["priority"] })}
            >
              {PRIORITIES.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </dd>

          <dt>Due</dt>
          <dd>
            <DatePicker
              value={task.due}
              onChange={(due) => set({ due })}
              disabled={!canEdit}
              tone={cn(dueState(task.due, done) === "overdue" && "text-destructive font-medium")}
            />
          </dd>

          <dt>Start</dt>
          <dd>
            <DatePicker value={task.start} onChange={(start) => set({ start })} disabled={!canEdit} />
          </dd>

          <dt>Estimate</dt>
          <dd>
            <EstimateInput
              key={task.id}
              value={task.estimate}
              disabled={!canEdit}
              onSave={(estimate) => set({ estimate })}
            />
          </dd>

          <dt>Tags</dt>
          <dd>
            <TagPicker value={task.tags} onChange={(t) => set({ tags: t })} known={knownTags} disabled={!canEdit}>
              {task.tags.length === 0 ? (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Tag className="size-3.5" /> None
                </span>
              ) : (
                task.tags.map((t) => (
                  <span key={t} className="kanban-tag">
                    {t}
                  </span>
                ))
              )}
            </TagPicker>
          </dd>

          <dt>Parent</dt>
          <dd className="flex items-center gap-1">
            {parent ? (
              <>
                <button type="button" className="truncate text-sm hover:underline" onClick={() => openTask(parent.id)}>
                  {parent.key} {parent.title}
                </button>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Make it stand on its own"
                    onClick={() => set({ parent: undefined })}
                  >
                    <X />
                  </Button>
                )}
              </>
            ) : (
              <TaskPicker
                tasks={others.filter((t) => !isAncestor(task.id, t.id, tasks))}
                onPick={(t) => set({ parent: t.id })}
                disabled={!canEdit}
              >
                <span className="text-muted-foreground">None</span>
              </TaskPicker>
            )}
          </dd>

          <dt>Reporter</dt>
          <dd className="text-sm">{task.reporter ? (people.get(task.reporter)?.displayName ?? "Someone") : "—"}</dd>
        </dl>

        <LinkedDoc task={task} tree={tree.docs} canEdit={canEdit} onError={setError} />
        {error && <p className="text-sm text-destructive">{error}</p>}

        <section className="kanban-panel-section">
          <h3>
            Sub-tasks
            {subtasks.length > 0 && (
              <span className="kanban-count">
                {subtasks.filter((s) => columnOf(s, columns)?.category === "done").length}/{subtasks.length}
              </span>
            )}
          </h3>
          <ul className="kanban-subtask-list">
            {subtasks.map((s) => {
              const sDone = columnOf(s, columns)?.category === "done";
              return (
                <li key={s.id}>
                  <input
                    type="checkbox"
                    aria-label={`${s.key} done`}
                    checked={sDone}
                    disabled={!canEdit}
                    onChange={() => {
                      const to = columns.find((c) => c.category === (sDone ? "todo" : "done")) ?? columns[0];
                      if (to) {
                        const last = tasksIn(to.id, columns, tasks.values()).at(-1);
                        moveTask(doc, s.id, to.id, last?.id ?? null, null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 flex-1 truncate text-left text-sm hover:underline",
                      sDone && "line-through text-muted-foreground",
                    )}
                    onClick={() => openTask(s.id)}
                  >
                    <span className="mr-1.5 font-mono text-xs text-muted-foreground">{s.key}</span>
                    {s.title}
                  </button>
                  <span className="text-xs text-muted-foreground">{columnOf(s, columns)?.name}</span>
                </li>
              );
            })}
          </ul>
          {canEdit && (
            <AddInline
              placeholder="Add a sub-task"
              onAdd={async (title) => {
                const column = columns.find((c) => c.category === "todo") ?? columns[0];
                if (column) await createTask({ title, column: column.id, parent: task.id });
              }}
            />
          )}
        </section>

        <section className="kanban-panel-section">
          <h3>Linked tasks</h3>
          <ul className="kanban-link-list">
            {links.map((l) => (
              <li key={l.relation.id}>
                <span className={cn("kanban-link-label", l.blockedBy && "text-destructive")}>{l.label}</span>
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
                  onClick={() => openTask(l.other.id)}
                >
                  <span className="mr-1.5 font-mono text-xs text-muted-foreground">{l.other.key}</span>
                  <span className={cn(columnOf(l.other, columns)?.category === "done" && "line-through")}>
                    {l.other.title}
                  </span>
                </button>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Remove link"
                    onClick={() => removeRelation(doc, l.relation.id)}
                  >
                    <X />
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {canEdit && <AddLink task={task} others={others} />}
        </section>

        <Mentions taskKey={task.key} />

        <section className="kanban-panel-section">
          <h3>Description</h3>
          {task.docId ? (
            <p className="text-sm text-muted-foreground">This task's description is its doc, above.</p>
          ) : (
            <TaskDescription key={task.id} taskId={task.id} />
          )}
        </section>

        <p className="kanban-panel-meta">
          {task.createdAt && <>Created {new Date(task.createdAt).toLocaleString()}</>}
          {task.createdBy && people.get(task.createdBy) && <> by {people.get(task.createdBy)?.displayName}</>}
          {task.updatedAt && <> · Updated {new Date(task.updatedAt).toLocaleString()}</>}
        </p>
      </div>
    </aside>
  );
}

/** Docs that link this task with [[task:KEY]]. */
function Mentions({ taskKey }: { taskKey: string }) {
  const { kanbanId } = useKanbanContext();
  const mentions = useQuery({ ...kanbanQueries.mentions(kanbanId, taskKey), enabled: !!taskKey });
  if (!mentions.data?.length) return null;
  return (
    <section className="kanban-panel-section">
      <h3>Mentioned in</h3>
      <ul>
        {mentions.data.map((d) => (
          <li key={d.docId}>
            <button
              type="button"
              className="flex items-center gap-1.5 text-sm hover:underline"
              onClick={() => navigate(docPath(d.organizationId, d.docId))}
            >
              <FileText className="size-3.5 text-muted-foreground" />
              {pathOf(d)}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">
        Link it from a doc with <code>[[task:{taskKey}]]</code>.
      </p>
    </section>
  );
}

function TitleInput({ task, canEdit, onSave }: { task: Task; canEdit: boolean; onSave: (title: string) => void }) {
  const [value, setValue] = useState(task.title);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setValue(task.title);
  }, [task.title]);
  const save = () => {
    editing.current = false;
    if (value.trim() && value.trim() !== task.title) onSave(value);
    else setValue(task.title);
  };
  return (
    <textarea
      className="kanban-panel-title"
      rows={1}
      value={value}
      maxLength={500}
      readOnly={!canEdit}
      aria-label="Title"
      onFocus={() => (editing.current = true)}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, " "))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
        if (e.key === "Escape") {
          setValue(task.title);
          editing.current = false;
        }
      }}
    />
  );
}

function EstimateInput({
  value,
  disabled,
  onSave,
}: {
  value?: number;
  disabled: boolean;
  onSave: (v: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  return (
    <input
      className="h-8 w-24 rounded-xl bg-transparent px-2 text-sm hover:bg-muted focus:bg-muted focus:outline-none"
      inputMode="decimal"
      placeholder="Points"
      aria-label="Estimate"
      disabled={disabled}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Number.parseFloat(text);
        const next = Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : undefined;
        if (next !== value) onSave(next);
      }}
    />
  );
}

function AddInline({ placeholder, onAdd }: { placeholder: string; onAdd: (title: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      await onAdd(value);
      setValue("");
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-1 flex items-center gap-1">
      <Plus className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        className="h-8 min-w-0 flex-1 rounded-lg bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground focus:bg-muted"
        placeholder={placeholder}
        value={value}
        disabled={busy}
        maxLength={500}
        onChange={(e) => setValue(e.target.value)}
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </form>
  );
}

function AddLink({ task, others }: { task: Task; others: Task[] }) {
  const { doc } = useKanbanContext();
  const [type, setType] = useState<RelationType | "blocked-by">("blocks");
  return (
    <div className="mt-1 flex items-center gap-1">
      <NativeSelect
        size="sm"
        aria-label="How they're linked"
        value={type}
        onChange={(e) => setType(e.target.value as RelationType)}
      >
        {RELATION_TYPES.map((t) => (
          <NativeSelectOption key={t} value={t}>
            {RELATION_LABELS[t].out}
          </NativeSelectOption>
        ))}
        <NativeSelectOption value="blocked-by">is blocked by</NativeSelectOption>
      </NativeSelect>
      <TaskPicker
        tasks={others}
        onPick={(other) =>
          type === "blocked-by"
            ? addRelation(doc, other.id, task.id, "blocks")
            : addRelation(doc, task.id, other.id, type)
        }
      >
        <Link2 className="size-3.5" /> Pick a task
      </TaskPicker>
    </div>
  );
}

/* ------------------------------------------------------------------ the description, and the doc it can become */

function useEditorHooks(): EditorHooks {
  const { tree, orgId } = useKanbanContext();
  const treeRef = useRef(tree);
  treeRef.current = tree;
  return useMemo<EditorHooks>(
    () => ({
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
      ...taskHooks(orgId, () => undefined),
    }),
    [orgId],
  );
}

/** The task's description: the docs editor on its shared text, so several people can write in it at once. */
function TaskDescription({ taskId }: { taskId: string }) {
  const { doc, session, canEdit } = useKanbanContext();
  const host = useRef<HTMLDivElement>(null);
  const hooks = useEditorHooks();
  const editor = useRef<DocEditor | null>(null);
  const [text] = useState<Y.Text | null>(() =>
    canEdit
      ? descriptionOf(doc, taskId)
      : ((doc.getMap("tasks").get(taskId) as Y.Map<unknown> | undefined)?.get("description") as Y.Text | null),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: made once per task; edit rights change it below, not by making it again
  useEffect(() => {
    if (!host.current || !text || !session) return;
    editor.current = createEditor(host.current, { text, awareness: session.awareness, canEdit }, hooks);
    return () => {
      editor.current?.destroy();
      editor.current = null;
    };
  }, [text, session, hooks]);
  useEffect(() => editor.current?.setEditable(canEdit), [canEdit]);
  if (!text) return <p className="text-sm text-muted-foreground">No description.</p>;
  return <div ref={host} className="doc-editor kanban-description" />;
}

/** The doc the task links to or became: its live editor, or buttons to make one or link one. */
function LinkedDoc({
  task,
  tree,
  canEdit,
  onError,
}: {
  task: Task;
  tree: DocSummary[];
  canEdit: boolean;
  onError: (m: string) => void;
}) {
  const { doc, orgId, kanbanId } = useKanbanContext();
  const linked = task.docId ? tree.find((d) => d.id === task.docId) : undefined;
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const becomeDoc = async () => {
    setBusy(true);
    onError("");
    try {
      const folder = tree.find((d) => d.id === kanbanId)?.folder ?? "";
      const title = `${task.key} ${task.title}`
        .replace(/[[\]|#/\\^]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      const created = await docsApi.create(orgId, title, folder, "doc");
      const description = descriptionOf(doc, task.id);
      const body = description?.toString().trim() ?? "";
      await editDoc(created.id, (text) => text.insert(0, `${body ? `${body}\n\n` : ""}Task: [[task:${task.key}]]\n`));
      doc.transact(() => {
        updateTask(doc, task.id, { docId: created.id });
        if (description?.length) description.delete(0, description.length);
      });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (task.docId) {
    return (
      <section className="kanban-panel-section">
        <h3 className="flex items-center gap-2">
          <FileText className="size-4" />
          {linked ? pathOf(linked) : "A doc you can't open (or that's deleted)"}
          <span className="flex-1" />
          {linked && (
            <Button variant="ghost" size="xs" onClick={() => navigate(docPath(orgId, linked.id))}>
              Open
            </Button>
          )}
          {canEdit && (
            <Button
              variant="ghost"
              size="xs"
              title="Unlink the doc (it stays where it is)"
              onClick={() => updateTask(doc, task.id, { docId: undefined })}
            >
              <Unlink data-icon="inline-start" /> Unlink
            </Button>
          )}
        </h3>
        {linked && <LinkedDocEditor key={linked.id} docId={linked.id} />}
      </section>
    );
  }

  if (!canEdit) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void becomeDoc()}>
        <FileText data-icon="inline-start" /> Open as doc
      </Button>
      <Popover onOpenChange={(open) => !open && setQuery("")}>
        <PopoverTrigger className="inline-flex h-8 items-center gap-1 rounded-4xl px-3 text-sm hover:bg-muted">
          <Link2 className="size-3.5" /> Link a doc
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <PickerList
            items={tree.filter((d) => d.kind === "doc")}
            query={query}
            onQuery={setQuery}
            label={(d) => pathOf(d)}
            placeholder="Find a doc"
            isSelected={() => false}
            onPick={(d) => updateTask(doc, task.id, { docId: d.id })}
            render={(d) => pathOf(d)}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** The linked doc's own live editor, in the panel: the same copy as on its page. */
function LinkedDocEditor({ docId }: { docId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const hooks = useEditorHooks();
  const [status, setStatus] = useState("Connecting…");
  useEffect(() => {
    const session = new DocSession(docId);
    let editor: DocEditor | null = null;
    const mount = () => {
      if (!session.loaded || editor || !host.current) return;
      setStatus("");
      editor = createEditor(host.current, session, hooks);
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
  }, [docId, hooks]);
  return (
    <div className="kanban-linked-doc">
      {status && <p className="p-2 text-sm text-muted-foreground">{status}</p>}
      <div ref={host} className="doc-editor" />
    </div>
  );
}
